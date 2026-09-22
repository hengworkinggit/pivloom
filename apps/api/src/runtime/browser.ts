import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OpenSandboxWorkspace, shellQuote } from "./workspace.js";
import {
  RuntimeError,
  type WorkspaceHandle,
  type ProbeEventSink,
} from "./types.js";

export interface BrowserObservation {
  id: string;
  sessionId: string;
  url: string;
  tree: string;
  text: string;
  truncated: boolean;
  refs: Record<string, { role?: string; name?: string }>;
}
const ref = z.string().regex(/^e[0-9]{1,6}$/);
const observationId = z.string().min(1).max(100);
// Shell quoting cannot prevent a CLI parser from interpreting an option value.
const value = z
  .string()
  .max(2000)
  .refine((text) => !text.includes("\0") && !/^\s*-(?:-|[a-z])/i.test(text));
const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("click"), ref, observationId }),
  z.strictObject({ type: z.literal("fill"), ref, text: value, observationId }),
  z.strictObject({ type: z.literal("select"), ref, value, observationId }),
  z.strictObject({
    type: z.literal("press"),
    key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]),
    observationId: observationId.optional(),
  }),
  z.strictObject({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    observationId: observationId.optional(),
  }),
]);
export type BrowserAction = z.infer<typeof actionSchema>;
function boundedText(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\ud800-\udbff]$/, "");
}
export class RemoteBrowser {
  private readonly session: string;
  private observation?: { id: string; url: string; refs: Set<string> };
  private closed = false;
  private stopped = false;
  private started = false;
  private operating = false;
  private commandsInFlight = 0;
  private deadline = 0;
  constructor(
    private workspace: OpenSandboxWorkspace,
    private handle: WorkspaceHandle,
    private onEvent?: ProbeEventSink,
    sessionId = "pivloom-" + randomUUID(),
  ) {
    if (
      !/^pivloom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        sessionId,
      )
    )
      throw new RuntimeError("INVALID_BROWSER_SESSION", "无效浏览器会话");
    this.session = sessionId;
  }
  get sessionId(): string {
    return this.session;
  }
  async open(path = "/"): Promise<BrowserObservation> {
    return this.exclusive(() => this.openPage(path));
  }
  private async openPage(path: string): Promise<BrowserObservation> {
    this.assertOpen();
    if (
      typeof path !== "string" ||
      path.length > 2048 ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(path)
    ) {
      await this.close();
      throw new RuntimeError(
        "BROWSER_ORIGIN_REJECTED",
        "浏览器只能访问本候选预览",
      );
    }
    this.observation = undefined;
    if (this.started) await this.checkOrigin();
    this.started = true;
    await this.call(["open", "http://127.0.0.1:4173" + path]);
    return this.observePage();
  }
  async observe(): Promise<BrowserObservation> {
    return this.exclusive(() => this.observePage());
  }
  private async observePage(): Promise<BrowserObservation> {
    this.observation = undefined;
    const beforeUrl = await this.checkOrigin();
    const data = await this.call(["snapshot", "-i"]);
    const body = await this.call(["get", "text", "body"]);
    const url = await this.checkOrigin();
    if (url !== beforeUrl)
      throw new RuntimeError(
        "BROWSER_OBSERVATION_CHANGED",
        "观察期间页面发生导航，请重新观察",
      );
    if (typeof data.snapshot !== "string" || typeof body.text !== "string")
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器观察缺少正文或结构");
    const tree = boundedText(data.snapshot, 12000);
    const text = boundedText(body.text, 12000);
    let truncated = tree !== data.snapshot || text !== body.text;
    const treeRefs = new Set<string>();
    for (const match of tree.matchAll(/\[([^\[\]\r\n]*)\]/g)) {
      for (const attribute of match[1].split(",")) {
        const member = /^ref=(e[0-9]{1,6})$/.exec(attribute.trim());
        if (member) treeRefs.add(member[1]);
      }
    }
    const refs: BrowserObservation["refs"] = {};
    const entries =
      typeof data.refs === "object" &&
      data.refs !== null &&
      !Array.isArray(data.refs)
        ? Object.entries(data.refs)
        : [];
    for (const [key, item] of entries) {
      if (
        Object.keys(refs).length >= 100 ||
        !/^e[0-9]{1,6}$/.test(key) ||
        !treeRefs.has(key) ||
        typeof item !== "object" ||
        item === null
      ) {
        truncated = true;
        continue;
      }
      const metadata = item as Record<string, unknown>;
      const role =
        typeof metadata.role === "string"
          ? boundedText(metadata.role, 64)
          : undefined;
      const name =
        typeof metadata.name === "string"
          ? boundedText(metadata.name, 160)
          : undefined;
      if (role !== metadata.role || name !== metadata.name) truncated = true;
      refs[key] = {
        ...(role === undefined ? {} : { role }),
        ...(name === undefined ? {} : { name }),
      };
    }
    const observation = {
      id: randomUUID(),
      sessionId: this.session,
      url,
      tree,
      text,
      truncated,
      refs,
    };
    this.observation = {
      id: observation.id,
      url,
      refs: new Set(Object.keys(refs)),
    };
    return observation;
  }
  async act(action: BrowserAction): Promise<BrowserObservation> {
    return this.exclusive(() => this.performAction(action));
  }
  private async performAction(
    action: BrowserAction,
  ): Promise<BrowserObservation> {
    this.assertOpen();
    const parsed = actionSchema.safeParse(action);
    if (!parsed.success) {
      await this.close();
      throw new RuntimeError("INVALID_BROWSER_ACTION", "无效浏览器动作或参数");
    }
    action = parsed.data;
    if (
      !this.observation ||
      (action.observationId !== undefined &&
        action.observationId !== this.observation.id)
    )
      throw new RuntimeError("STALE_BROWSER_REF", "请重新观察后使用本会话引用");
    if ("ref" in action) {
      if (
        action.observationId !== this.observation?.id ||
        !this.observation.refs.has(action.ref)
      )
        throw new RuntimeError(
          "STALE_BROWSER_REF",
          "请重新观察后使用本会话引用",
        );
    }
    const url = await this.checkOrigin();
    if (this.observation && url !== this.observation.url) {
      this.observation = undefined;
      throw new RuntimeError("STALE_BROWSER_REF", "页面已经变化，请重新观察");
    }
    this.observation = undefined;
    const args =
      action.type === "click"
        ? ["click", "@" + action.ref]
        : action.type === "fill"
          ? ["fill", "@" + action.ref, action.text.slice(0, 2000)]
          : action.type === "select"
            ? ["select", "@" + action.ref, action.value.slice(0, 2000)]
            : action.type === "scroll"
              ? ["scroll", action.direction, "600"]
              : ["press", action.key];
    await this.call(args);
    await this.onEvent?.({
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "browser.action",
      message: `浏览器 ${action.type}`,
      success: true,
    });
    return this.observePage();
  }
  async screenshot() {
    return this.exclusive(() => this.captureScreenshot());
  }
  private async captureScreenshot() {
    await this.checkOrigin();
    const name = randomUUID() + ".png";
    await this.workspace.executeService(
      this.handle,
      "mkdir -p /tmp/pivloom-browser",
      { uid: 0, timeoutMs: this.remainingTime() },
    );
    await this.call(["screenshot", "/tmp/pivloom-browser/" + name]);
    const bytes = await this.workspace.readArtifact(this.handle, name);
    await this.checkOrigin();
    if (
      bytes.byteLength > 2 * 1024 * 1024 ||
      !Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    )
      throw new RuntimeError("INVALID_SCREENSHOT", "截图格式或大小错误");
    return {
      base64: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png" as const,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  async text(): Promise<string> {
    return this.exclusive(() => this.readText());
  }
  private async readText(): Promise<string> {
    await this.checkOrigin();
    const data = await this.call(["get", "text", "body"]);
    await this.checkOrigin();
    if (typeof data.text !== "string")
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器没有返回正文");
    return boundedText(data.text, 12000);
  }
  async logs(): Promise<Record<string, unknown>> {
    return this.exclusive(() => this.readLogs());
  }
  private async readLogs(): Promise<Record<string, unknown>> {
    await this.checkOrigin();
    const data = await this.call(["errors"]);
    await this.checkOrigin();
    return data;
  }
  async close(): Promise<{ confirmed: boolean }> {
    this.stopped = true;
    this.observation = undefined;
    if (this.closed || !this.started) {
      this.closed = true;
      return { confirmed: true };
    }
    const hadPendingCommand = this.commandsInFlight > 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.call(["close"], true),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RuntimeError("BROWSER_TIMEOUT", "关闭浏览器超时")),
            15000,
          );
        }),
      ]);
      // A late open/get-url may start Chrome after the close acknowledgement.
      // Keep cleanup unconfirmed until its command settles and close is retried.
      if (hadPendingCommand || this.commandsInFlight > 0)
        return { confirmed: false };
      this.closed = true;
      return { confirmed: true };
    } catch {
      return { confirmed: false };
    } finally {
      clearTimeout(timer);
    }
  }
  private async checkOrigin() {
    const data = await this.call(["get", "url"]);
    let url: URL | undefined;
    try {
      if (typeof data.url === "string") url = new URL(data.url);
    } catch {
      /* Malformed URL is treated like an origin escape. */
    }
    if (
      !url ||
      url.origin !== "http://127.0.0.1:4173" ||
      url.username ||
      url.password
    ) {
      await this.close();
      throw new RuntimeError(
        "BROWSER_ORIGIN_REJECTED",
        "浏览器离开候选预览来源",
      );
    }
    this.started = true;
    return url.href;
  }
  private assertOpen(): void {
    if (this.stopped) throw new RuntimeError("BROWSER_CLOSED", "浏览器已关闭");
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.operating)
      throw new RuntimeError("BROWSER_BUSY", "浏览器动作仍在进行");
    this.operating = true;
    this.deadline = Date.now() + 15000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.stopped = true;
        this.observation = undefined;
        reject(new RuntimeError("BROWSER_TIMEOUT", "浏览器动作超过 15 秒"));
      }, 15000);
    });
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "BROWSER_TIMEOUT")
        await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      this.operating = false;
      this.deadline = 0;
    }
  }
  private remainingTime(): number {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new RuntimeError("BROWSER_TIMEOUT", "浏览器动作超过 15 秒");
    return remaining;
  }
  private async call(
    args: string[],
    closing = false,
  ): Promise<Record<string, unknown>> {
    if (!closing) this.assertOpen();
    const command = [
      "agent-browser",
      "--session",
      this.session,
      "--json",
      ...args,
    ]
      .map(shellQuote)
      .join(" ");
    this.started = true;
    if (!closing) this.commandsInFlight++;
    let result;
    try {
      result = await this.workspace.executeService(this.handle, command, {
        uid: 0,
        timeoutMs: closing ? 15000 : this.remainingTime(),
      });
    } finally {
      if (!closing) this.commandsInFlight--;
    }
    if (!closing) {
      this.assertOpen();
      this.remainingTime();
    }
    if (result.exitCode !== 0)
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器命令未完成");
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdoutTail);
    } catch {
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器响应格式错误");
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("success" in raw) ||
      raw.success !== true
    )
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器动作失败");
    if (!("data" in raw) || raw.data === undefined) return {};
    if (
      typeof raw.data !== "object" ||
      raw.data === null ||
      Array.isArray(raw.data)
    )
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器响应格式错误");
    return raw.data as Record<string, unknown>;
  }
}
