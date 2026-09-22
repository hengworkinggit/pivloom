import { createHash, randomUUID } from "node:crypto";
import { OpenSandboxWorkspace, shellQuote } from "./workspace.js";
import {
  RuntimeError,
  type WorkspaceHandle,
  type ProbeEventSink,
} from "./types.js";

export interface BrowserObservation {
  id: string;
  url: string;
  tree: string;
  refs: Record<string, { role?: string; name?: string }>;
}
export type BrowserAction =
  | { type: "click"; ref: string; observationId: string }
  | { type: "fill"; ref: string; text: string; observationId: string }
  | { type: "select"; ref: string; value: string; observationId: string }
  | {
      type: "press";
      key: "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp";
    };
export class RemoteBrowser {
  private readonly session = "pivloom-" + randomUUID();
  private observation?: BrowserObservation;
  private closed = false;
  constructor(
    private workspace: OpenSandboxWorkspace,
    private handle: WorkspaceHandle,
    private onEvent?: ProbeEventSink,
  ) {}
  async open(path = "/"): Promise<BrowserObservation> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("\0")
    )
      throw new RuntimeError(
        "BROWSER_ORIGIN_REJECTED",
        "浏览器只能访问本候选预览",
      );
    await this.call(["open", "http://127.0.0.1:4173" + path]);
    return this.observe();
  }
  async observe(): Promise<BrowserObservation> {
    await this.checkOrigin();
    const data = await this.call(["snapshot", "-i"]);
    const refs =
      typeof data.refs === "object" && data.refs !== null
        ? (data.refs as BrowserObservation["refs"])
        : {};
    this.observation = {
      id: randomUUID(),
      url: "http://127.0.0.1:4173",
      tree: String(data.snapshot ?? ""),
      refs,
    };
    return this.observation;
  }
  async act(action: BrowserAction): Promise<BrowserObservation> {
    if ("ref" in action) {
      if (
        action.observationId !== this.observation?.id ||
        !this.observation.refs[action.ref]
      )
        throw new RuntimeError(
          "STALE_BROWSER_REF",
          "请重新观察后使用本会话引用",
        );
      if (!/^e[0-9]+$/.test(action.ref))
        throw new RuntimeError("INVALID_BROWSER_REF", "无效浏览器引用");
    }
    await this.checkOrigin();
    this.observation = undefined;
    const args =
      action.type === "click"
        ? ["click", "@" + action.ref]
        : action.type === "fill"
          ? ["fill", "@" + action.ref, action.text.slice(0, 2000)]
          : action.type === "select"
            ? ["select", "@" + action.ref, action.value.slice(0, 2000)]
            : ["press", action.key];
    await this.call(args);
    await this.onEvent?.({
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "browser.action",
      message: `浏览器 ${action.type}`,
      success: true,
    });
    return this.observe();
  }
  async screenshot() {
    await this.checkOrigin();
    const name = randomUUID() + ".png";
    await this.workspace.executeService(
      this.handle,
      "mkdir -p /tmp/pivloom-browser",
      { uid: 0 },
    );
    await this.call(["screenshot", "/tmp/pivloom-browser/" + name]);
    const bytes = await this.workspace.readArtifact(this.handle, name);
    if (
      bytes.byteLength > 5 * 1024 * 1024 ||
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
    await this.checkOrigin();
    const data = await this.call(["get", "text", "body"]);
    return String(data.text ?? "");
  }
  async logs(): Promise<Record<string, unknown>> {
    return this.call(["errors"]);
  }
  async close(): Promise<{ confirmed: boolean }> {
    if (this.closed) return { confirmed: true };
    try {
      await this.call(["close"]);
      this.closed = true;
      return { confirmed: true };
    } catch {
      return { confirmed: false };
    }
  }
  private async checkOrigin() {
    const data = await this.call(["get", "url"]);
    if (
      typeof data.url !== "string" ||
      new URL(data.url).origin !== "http://127.0.0.1:4173"
    ) {
      await this.close();
      throw new RuntimeError(
        "BROWSER_ORIGIN_REJECTED",
        "浏览器离开候选预览来源",
      );
    }
  }
  private async call(args: string[]): Promise<Record<string, unknown>> {
    if (this.closed) throw new RuntimeError("BROWSER_CLOSED", "浏览器已关闭");
    const command = [
      "agent-browser",
      "--session",
      this.session,
      "--json",
      ...args,
    ]
      .map(shellQuote)
      .join(" ");
    const result = await this.workspace.executeService(this.handle, command, {
      uid: 0,
      timeoutMs: 30000,
    });
    if (result.exitCode !== 0)
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器命令未完成");
    const raw = JSON.parse(result.stdoutTail) as {
      success?: boolean;
      data?: Record<string, unknown>;
    };
    if (!raw.success)
      throw new RuntimeError("BROWSER_BLOCKED", "浏览器动作失败");
    return raw.data ?? {};
  }
}
