import {
  ApiErrorSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  MeResponseSchema,
  ProjectDetailResponseSchema,
  ProjectListResponseSchema,
  type MeResponse,
} from "@pivloom/contracts";
import { clearDrafts } from "./drafts";

/** The external identity boundary. Access tokens never enter the UI snapshot. */
export interface TokenSession { accessToken: string; userId: string }
export interface IdentityPort {
  getSession(): Promise<TokenSession | null>;
  getUser(accessToken: string): Promise<{ id: string }>;
  signIn(email: string, password: string): Promise<TokenSession>;
  refreshSession(): Promise<TokenSession | null>;
  signOut(): Promise<void>;
  subscribe(listener: (session: TokenSession | null) => void): () => void;
}
export interface AuthSnapshot {
  status: "loading" | "anonymous" | "authenticated" | "error";
  user: MeResponse["user"] | null;
  error: string;
  epoch: number;
}
export const INITIAL_AUTH: AuthSnapshot = { status: "loading", user: null, error: "", epoch: 0 };
export class WorkspaceError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "WorkspaceError";
  }
}
const signedOut = () => new WorkspaceError("UNAUTHENTICATED", "登录已失效，请重新登录。", 401);

export function createApiWorkspace(identity: IdentityPort, transport: typeof fetch = fetch) {
  let snapshot = INITIAL_AUTH;
  let initialized = false;
  let boot: Promise<void> | undefined;
  let endingSession: Promise<void> | undefined;
  let authenticating = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();

  function publish(next: AuthSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  function invalidate(status: AuthSnapshot["status"], error = "") {
    requests.forEach((request) => request.abort());
    requests.clear();
    publish({ status, user: null, error, epoch: snapshot.epoch + 1 });
    return snapshot.epoch;
  }
  function assertEpoch(epoch: number) {
    if (snapshot.epoch !== epoch) throw signedOut();
  }
  function endSession() {
    if (!endingSession) {
      endingSession = identity.signOut().finally(() => { endingSession = undefined; });
    }
    return endingSession;
  }
  async function readJson(response: Response) {
    if (response.status === 204) return null;
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new WorkspaceError("INVALID_RESPONSE", "服务返回了无法读取的响应，请稍后重试。", response.status); }
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(data);
      if (response.status === 401) throw signedOut();
      if (response.status === 404) throw new WorkspaceError("NOT_FOUND", "项目或配置不存在，或你没有访问权限。", response.status);
      throw new WorkspaceError(parsed.success ? parsed.data.error.code : "API_ERROR",
        parsed.success ? parsed.data.error.message : "服务暂时不可用，请稍后重试。", response.status);
    }
    return data;
  }
  async function verifySession(session: TokenSession, epoch: number) {
    const verified = await identity.getUser(session.accessToken);
    assertEpoch(epoch);
    if (verified.id !== session.userId) throw signedOut();
    const response = await transport("/api/v1/me", {
      headers: { Authorization: `Bearer ${session.accessToken}` }, cache: "no-store",
    });
    const { user } = MeResponseSchema.parse(await readJson(response));
    assertEpoch(epoch);
    if (user.id !== verified.id) throw signedOut();
    publish({ status: "authenticated", user, error: "", epoch });
  }
  function authFailure(error: unknown, epoch: number) {
    if (snapshot.epoch !== epoch) return;
    if (error instanceof WorkspaceError && error.code === "UNAUTHENTICATED") {
      invalidate("anonymous", error.message);
      void endSession().catch(() => {});
    } else {
      invalidate("error", "暂时无法连接工作空间，请检查服务状态后重试。");
    }
  }
  async function acceptChangedIdentity(session: TokenSession | null) {
    if (!session) { invalidate("anonymous"); return; }
    if (authenticating || snapshot.user?.id === session.userId) return;
    const epoch = invalidate("loading");
    try { await verifySession(session, epoch); }
    catch (error) { authFailure(error, epoch); }
  }
  async function initialize() {
    if (initialized) return boot;
    initialized = true;
    unsubscribe = identity.subscribe((session) => {
      // Supabase holds its auth lock during callbacks. No SDK calls are awaited here.
      if (!session) invalidate("anonymous");
      else queueMicrotask(() => { void acceptChangedIdentity(session); });
    });
    const epoch = invalidate("loading");
    authenticating = true;
    boot = (async () => {
      try {
        const session = await identity.getSession();
        assertEpoch(epoch);
        if (session) await verifySession(session, epoch);
        else publish({ status: "anonymous", user: null, error: "", epoch });
      } catch (error) { authFailure(error, epoch); }
      finally { authenticating = false; }
    })();
    return boot;
  }
  async function login(email: string, password: string) {
    await initialize();
    await endingSession;
    const epoch = invalidate("loading");
    authenticating = true;
    try {
      const session = await identity.signIn(email.trim(), password);
      assertEpoch(epoch);
      await verifySession(session, epoch);
    } catch (error) {
      if (snapshot.epoch === epoch) {
        invalidate("anonymous");
        if (error instanceof WorkspaceError && error.code === "AUTH_UNAVAILABLE") throw error;
        throw new WorkspaceError("LOGIN_FAILED", "邮箱或密码不正确，或账号暂时无法登录。");
      }
      throw signedOut();
    } finally { authenticating = false; }
  }
  async function logout() {
    // Clear the page and invalidate pending requests before network sign-out finishes.
    if (snapshot.user) clearDrafts(snapshot.user.id);
    invalidate("anonymous");
    await endSession();
  }
  async function authorizedRequest<T>(path: string, init: RequestInit, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (snapshot.status !== "authenticated" || !snapshot.user) throw signedOut();
    const epoch = snapshot.epoch;
    const owner = snapshot.user.id;
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    requests.add(controller);
    try {
      let session = await identity.getSession();
      assertEpoch(epoch);
      if (!session || session.userId !== owner) throw signedOut();
      const send = (token: string) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        if (init.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
        return transport(`/api/v1${path}`, {
          ...init, cache: "no-store", signal, headers,
        });
      };
      let response = await send(session.accessToken);
      assertEpoch(epoch);
      if (response.status === 401) {
        session = await identity.refreshSession();
        assertEpoch(epoch);
        if (!session || session.userId !== owner) throw signedOut();
        response = await send(session.accessToken);
        assertEpoch(epoch);
      }
      if (!response.ok) await readJson(response);
      const value = await consume(response, signal);
      assertEpoch(epoch);
      return value;
    } catch (error) {
      assertEpoch(epoch);
      if (error instanceof WorkspaceError && error.code === "UNAUTHENTICATED") {
        invalidate("anonymous", error.message);
        void endSession().catch(() => {});
      }
      if (error instanceof TypeError) throw new WorkspaceError("NETWORK_ERROR", "无法连接服务，请检查网络后重试。");
      throw error;
    } finally { requests.delete(controller); }
  }
  const request = (path: string, init: RequestInit = {}): Promise<unknown> => authorizedRequest(path, init, readJson);
  const requestBlob = (path: string, init: RequestInit = {}): Promise<Blob> => authorizedRequest(path, init, (response) => response.blob());
  const requestStream = (path: string, consume: (response: Response, signal: AbortSignal) => Promise<void>, init: RequestInit = {}): Promise<void> =>
    authorizedRequest(path, init, consume);
  return {
    mode: "api" as const,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize,
    retry: async () => { unsubscribe?.(); initialized = false; await initialize(); },
    login,
    logout,
    request, requestStream, requestBlob,
    listProjects: async (cursor?: string) => ProjectListResponseSchema.parse(await request(`/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)),
    createProject: async (title?: string) => {
      const body = CreateProjectRequestSchema.parse(title ? { title } : {});
      return CreateProjectResponseSchema.parse(await request("/projects", { method: "POST", body: JSON.stringify(body) })).project;
    },
    getProject: async (id: string) => ProjectDetailResponseSchema.parse(await request(`/projects/${encodeURIComponent(id)}`)),
    dispose: () => { unsubscribe?.(); requests.forEach((request) => request.abort()); listeners.clear(); },
  };
}
export type ApiWorkspace = ReturnType<typeof createApiWorkspace>;
