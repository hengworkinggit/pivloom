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
export const BrowserPressKeySchema = z.enum(["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"]);
const keyBatchSchema = z.strictObject({
  observationId,
  steps: z.array(z.strictObject({ key: BrowserPressKeySchema, waitMs: z.number().int().min(0).max(1000) })).min(1).max(8),
}).refine((value) => value.steps.reduce((total, step) => total + step.waitMs, 0) <= 4000);
export type BrowserKeyBatch = z.infer<typeof keyBatchSchema>;
export interface BrowserKeyBatchResult {
  observation: BrowserObservation;
  startedAt: string;
  finishedAt: string;
  steps: Array<{ index: number; key: z.infer<typeof BrowserPressKeySchema>; waitMs: number; success: boolean }>;
}
const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("click"), ref, observationId }),
  z.strictObject({ type: z.literal("fill"), ref, text: value, observationId }),
  z.strictObject({ type: z.literal("select"), ref, value, observationId }),
  z.strictObject({
    type: z.literal("press"),
    key: BrowserPressKeySchema,
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
  private readonly stopController = new AbortController();
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
  async resize(width: number, height: number): Promise<BrowserObservation> {
    return this.exclusive(async () => {
      if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 320 || height > 2000)
        throw new RuntimeError("INVALID_BROWSER_ACTION", "视口宽高超出受控范围");
      if (!this.observation) throw new RuntimeError("STALE_BROWSER_REF", "请先打开并观察候选页面");
      const beforeUrl = await this.checkOrigin();
      this.observation = undefined;
      await this.call(["set", "viewport", String(width), String(height)]);
      await this.checkOrigin();
      // Fixed, read-only layout measurements; the model cannot supply script.
      const measured = await this.call(["eval", "({width:window.innerWidth,height:window.innerHeight,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth??0)})"]);
      const metrics = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), scrollWidth: z.number().int().nonnegative() }).safeParse(measured.result);
      if (!metrics.success || metrics.data.width !== width || metrics.data.height !== height)
        throw new RuntimeError("BROWSER_BLOCKED", "浏览器未确认请求的实际视口尺寸");
      const observation = await this.observePage();
      if (observation.url !== beforeUrl) throw new RuntimeError("BROWSER_OBSERVATION_CHANGED", "调整视口时页面发生导航，请重新观察");
      return { ...observation, text: `[viewport] width=${metrics.data.width} height=${metrics.data.height} scrollWidth=${metrics.data.scrollWidth}\n${observation.text}` };
    });
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
  async keyBatch(input: BrowserKeyBatch): Promise<BrowserKeyBatchResult> {
    return this.exclusive(async () => {
      const parsed = keyBatchSchema.safeParse(input);
      if (!parsed.success) throw new RuntimeError("INVALID_BROWSER_ACTION", "无效键盘动作序列");
      if (!this.observation || parsed.data.observationId !== this.observation.id)
        throw new RuntimeError("STALE_BROWSER_REF", "请重新观察后使用本会话引用");
      const url = await this.checkOrigin();
      if (url !== this.observation.url) {
        this.observation = undefined;
        throw new RuntimeError("STALE_BROWSER_REF", "页面已经变化，请重新观察");
      }
      this.observation = undefined;
      const commands = parsed.data.steps.flatMap((step) => [
        ["press", step.key], ...(step.waitMs ? [["wait", String(step.waitMs)]] : []),
      ]);
      const startedAt = new Date().toISOString();
      const results = await this.callBatch(commands);
      const finishedAt = new Date().toISOString();
      let position = 0;
      const steps = parsed.data.steps.map((step, index) => {
        const pressed = results[position++];
        const waited = step.waitMs ? results[position++] : undefined;
        return { index, key: step.key, waitMs: step.waitMs,
          success: pressed?.success === true && (!step.waitMs || waited?.success === true) };
      });
      for (const step of steps) await this.onEvent?.({ id: randomUUID(), at: finishedAt,
        type: "browser.action", message: `浏览器 batch ${step.index + 1}: ${step.key}`, success: step.success });
      return { observation: await this.observePage(), startedAt, finishedAt, steps };
    });
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
    this.stopController.abort();
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
        ...(closing ? {} : { signal: this.stopController.signal }),
      });
    } catch (error) {
      if (this.stopped && !closing)
        throw new RuntimeError("BROWSER_CLOSED", "浏览器已关闭");
      throw error;
    } finally {
      if (!closing) this.commandsInFlight--;
    }
    if (!closing) {
      this.assertOpen();
      this.remainingTime();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdoutTail);
    } catch {
      if (result.exitCode !== 0)
        throw new RuntimeError("BROWSER_BLOCKED", "浏览器命令未完成");
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器响应格式错误");
    }
    // A live game can replace a button after the snapshot but before click.
    // This exact official CLI error means the target vanished; the next model
    // turn may observe again. Other CLI/transport failures remain fatal.
    if (
      ["click", "fill", "select"].includes(args[0]) &&
      typeof raw === "object" && raw !== null &&
      "success" in raw && raw.success === false &&
      "error" in raw && typeof raw.error === "string" &&
      raw.error.startsWith("Could not locate element with role=")
    )
      throw new RuntimeError("STALE_BROWSER_REF", "页面控件已变化，请重新观察");
    if (result.exitCode !== 0)
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器命令未完成");
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
  private async callBatch(commands: string[][]): Promise<Array<{ command: string[]; success: boolean }>> {
    const cli = ["agent-browser", "--session", this.session, "--json", "batch", "--bail"]
      .map(shellQuote).join(" ");
    const command = `printf %s ${shellQuote(JSON.stringify(commands))} | ${cli}`;
    this.started = true;
    this.commandsInFlight++;
    let result;
    try {
      result = await this.workspace.executeService(this.handle, command, {
        uid: 0, timeoutMs: this.remainingTime(), signal: this.stopController.signal,
      });
    } catch (error) {
      if (this.stopped) throw new RuntimeError("BROWSER_CLOSED", "浏览器已关闭");
      throw error;
    } finally {
      this.commandsInFlight--;
    }
    this.assertOpen();
    this.remainingTime();
    let raw: unknown;
    try { raw = JSON.parse(result.stdoutTail); }
    catch { throw new RuntimeError("BROWSER_BLOCKED", "浏览器批量结果格式错误"); }
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > commands.length)
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器批量结果数量错误");
    const results = raw.map((entry, index) => {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.command)
        || entry.command.length !== commands[index].length
        || !entry.command.every((part: unknown, partIndex: number) => part === commands[index][partIndex])
        || typeof entry.success !== "boolean")
        throw new RuntimeError("BROWSER_BLOCKED", "浏览器批量结果与请求不匹配");
      return { command: commands[index], success: entry.success };
    });
    if ((result.exitCode !== 0) !== results.some((entry) => !entry.success))
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器批量退出状态与动作结果不一致");
    return results;
  }
}
