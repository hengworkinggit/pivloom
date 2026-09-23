import { createClient, type Session } from "@supabase/supabase-js";
import { createApiWorkspace, INITIAL_AUTH, WorkspaceError, type AuthSnapshot, type TokenSession } from "./api-workspace";
import { clearVisitedPrivatePreviews } from "./preview-session";

export const APP_MODE = process.env.NEXT_PUBLIC_APP_MODE ?? "api";
export const isDemoMode = APP_MODE === "demo";
function temporaryIdentityFailure(error: { status?: number } | null) {
  return !!error && (!error.status || error.status === 429 || error.status >= 500);
}
export interface WorkspaceAuth {
  mode: "api" | "demo";
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<void>;
  retry(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

export function configurationProblem() {
  if (APP_MODE !== "api" && APP_MODE !== "demo") return "NEXT_PUBLIC_APP_MODE 必须是 api 或 demo。";
  if (isDemoMode) return "";
  const missing = [
    !process.env.NEXT_PUBLIC_SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ].filter(Boolean);
  if (missing.length) return `工作空间尚未配置：缺少 ${missing.join("、")}。请配置后重新启动服务。`;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return "Supabase 地址需使用 HTTPS；本地开发可使用 localhost。";
    }
  } catch { return "Supabase 地址格式不正确。"; }
  if (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_secret_")) {
    return "前端只能配置 Supabase publishable key，请勿使用服务端 secret key。";
  }
  return "";
}

let api: ReturnType<typeof createApiWorkspace> | undefined;
let identityClient: ReturnType<typeof createClient> | undefined;
function getIdentityClient() {
  if (!identityClient) identityClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "pivloom.auth.v1" },
  });
  return identityClient;
}

export async function registerAccount(input: { name: string; email: string; password: string }) {
  const problem = configurationProblem();
  if (problem) throw new WorkspaceError("CONFIGURATION_ERROR", problem);
  const { data, error } = await getIdentityClient().auth.signUp({
    email: input.email.trim(), password: input.password,
    options: { data: { display_name: input.name.trim() } },
  });
  if (error || !data.user) throw new WorkspaceError("SIGNUP_FAILED", error?.message ?? "暂时无法注册，请稍后重试。");
  return { requiresConfirmation: !data.session };
}

export async function updateAccount(input: { name?: string; email?: string; password?: string }) {
  const { error } = await getIdentityClient().auth.updateUser({
    ...(input.name !== undefined ? { data: { display_name: input.name.trim() } } : {}),
    ...(input.email !== undefined ? { email: input.email.trim() } : {}),
    ...(input.password !== undefined ? { password: input.password } : {}),
  });
  if (error) throw new WorkspaceError("ACCOUNT_UPDATE_FAILED", error.message);
  if (input.name !== undefined) await getApiWorkspace().retry();
}

export function getApiWorkspace() {
  if (isDemoMode) throw new WorkspaceError("MODE_MISMATCH", "当前为演示模式。");
  const problem = configurationProblem();
  if (problem) throw new WorkspaceError("CONFIGURATION_ERROR", problem);
  if (api) return api;
  const storageKey = "pivloom.auth.v1";
  const supabase = getIdentityClient();
  const token = (session: Session | null): TokenSession | null => session ? { accessToken: session.access_token, userId: session.user.id } : null;
  api = createApiWorkspace({
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw new WorkspaceError("UNAUTHENTICATED", "登录已失效，请重新登录。");
      return token(data.session);
    },
    async getUser(accessToken) {
      const { data, error } = await supabase.auth.getUser(accessToken);
      if (error || !data.user) {
        if (temporaryIdentityFailure(error)) throw new WorkspaceError("AUTH_UNAVAILABLE", "登录服务暂时不可用，请稍后重试。");
        throw new WorkspaceError("UNAUTHENTICATED", "登录已失效，请重新登录。");
      }
      return { id: data.user.id };
    },
    async signIn(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        if (temporaryIdentityFailure(error)) throw new WorkspaceError("AUTH_UNAVAILABLE", "登录服务暂时不可用，请稍后重试。");
        throw new WorkspaceError("LOGIN_FAILED", "邮箱或密码不正确，或账号暂时无法登录。");
      }
      supabase.auth.startAutoRefresh();
      return token(data.session)!;
    },
    async refreshSession() {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) throw new WorkspaceError("UNAUTHENTICATED", "登录已失效，请重新登录。");
      return token(data.session);
    },
    async signOut() {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) {
        // Clear this browser's session, but do not claim the server revoked it.
        // A previously opened private Preview can remain accessible until Auth
        // confirms sign-out, so the UI must show an explicit unconfirmed state.
        await supabase.auth.stopAutoRefresh();
        localStorage.removeItem(storageKey);
      }
      void clearVisitedPrivatePreviews();
      if (error) throw new WorkspaceError("LOGOUT_UNCONFIRMED",
        "已清除本机登录，但服务器退出未确认；旧预览可能暂时仍可访问，请稍后重试。");
    },
    subscribe(listener) {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event !== "INITIAL_SESSION") listener(token(session));
      });
      return () => data.subscription.unsubscribe();
    },
  });
  return api;
}

let demo: WorkspaceAuth | undefined;
function getDemoAuth(): WorkspaceAuth {
  if (demo) return demo;
  let snapshot = INITIAL_AUTH;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: AuthSnapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
  async function sync() {
    const { demoApi } = await import("./mock-api");
    const session = await demoApi.getSession();
    publish({ status: session ? "authenticated" : "anonymous", user: session ? { id: "demo", ...session } : null, error: "", epoch: snapshot.epoch + 1 });
  }
  demo = {
    mode: "demo", getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() { if (!started) { started = true; await sync(); } },
    retry: sync,
    async login(email, password) { const { demoApi } = await import("./mock-api"); await demoApi.login(email, password); await sync(); },
    async logout() { publish({ status: "anonymous", user: null, error: "", epoch: snapshot.epoch + 1 }); const { demoApi } = await import("./mock-api"); await demoApi.logout(); },
  };
  return demo;
}

let unavailable: WorkspaceAuth | undefined;
export function getWorkspaceAuth(): WorkspaceAuth {
  if (isDemoMode) return getDemoAuth();
  const error = configurationProblem();
  if (!error) return getApiWorkspace();
  if (!unavailable) {
    const state: AuthSnapshot = { status: "error", user: null, error, epoch: 0 };
    unavailable = {
      mode: "api", getSnapshot: () => state, subscribe: () => () => {},
      initialize: async () => {}, retry: async () => {},
      login: async () => { throw new WorkspaceError("CONFIGURATION_ERROR", error); }, logout: async () => {},
    };
  }
  return unavailable;
}
