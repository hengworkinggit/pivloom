import {
  ConnectionConfig,
  Sandbox,
  SandboxApiException,
} from "@alibaba-group/opensandbox";
import { createHash, randomUUID } from "node:crypto";
import {
  RuntimeError,
  type CommandHandle,
  type CommandResult,
  type RemoteCommand,
  type SandboxConfig,
  type SourceFile,
  type WorkspaceHandle,
  type WorkspacePort,
} from "./types.js";

export interface RemoteProcess {
  id: string;
  wait(): Promise<CommandResult>;
  interrupt(): Promise<void>;
}
export interface SandboxConnection {
  sandboxId: string;
  kill(): Promise<void>;
  isRunning(): Promise<boolean>;
  renew(seconds: number): Promise<void>;
  close(): Promise<void>;
  endpoint(
    port: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  run(
    command: string,
    options: {
      timeoutMs: number;
      uid: number;
      cwd: string;
      onOutput?: (chunk: string) => void;
    },
  ): Promise<RemoteProcess>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
}
export interface SandboxConnector {
  create(config: SandboxConfig, runId: string): Promise<SandboxConnection>;
  connect?(
    config: SandboxConfig,
    sandboxId: string,
  ): Promise<SandboxConnection>;
}
export function sandboxConnectionConfig(
  config: SandboxConfig,
): ConnectionConfig {
  const url = new URL(config.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new RuntimeError(
      "INVALID_SANDBOX_CONFIG",
      "沙箱管理地址必须是无凭据的 HTTP(S) origin",
    );
  return new ConnectionConfig({
    domain: url.host,
    protocol: url.protocol === "https:" ? "https" : "http",
    apiKey: config.apiKey,
    requestTimeoutSeconds: 30,
    useServerProxy: true,
  });
}
const realConnector: SandboxConnector = {
  async create(config, runId) {
    // Do not pass caller abort to create: retain a late ID for confirmed cleanup.
    // The initial 180s TTL bounds a process crash before receiving that ID.
    const sandbox = await Sandbox.create({
      connectionConfig: sandboxConnectionConfig(config),
      image: config.image,
      resource: { cpu: "1", memory: "1Gi" },
      timeoutSeconds: 180,
      readyTimeoutSeconds: 90,
      env: {},
      metadata: { app: "pivloom", run_id: runId },
    });
    return adaptSandbox(sandbox, config);
  },
  async connect(config, sandboxId) {
    const sandbox = await Sandbox.connect({
      connectionConfig: sandboxConnectionConfig(config),
      sandboxId,
      readyTimeoutSeconds: 30,
    });
    return adaptSandbox(sandbox, config);
  },
};
function adaptSandbox(
  sandbox: Sandbox,
  config: SandboxConfig,
): SandboxConnection {
  return {
    sandboxId: sandbox.id,
    kill: () => sandbox.kill(),
    close: () => sandbox.close(),
    async isRunning() {
      try {
        await sandbox.getInfo();
        return true;
      } catch (e) {
        if (e instanceof SandboxApiException && e.statusCode === 404)
          return false;
        throw e;
      }
    },
    renew: async (seconds) => {
      await sandbox.renew(seconds);
    },
    async endpoint(port) {
      const ep = await sandbox.getEndpoint(port);
      return {
        url: `${new URL(config.baseUrl).protocol}//${ep.endpoint}`,
        headers: { ...ep.headers, "OPEN-SANDBOX-API-KEY": config.apiKey },
      };
    },
    async run(command, options) {
      const start = await sandbox.commands.run(command, {
        background: true,
        workingDirectory: options.cwd,
        timeoutSeconds: Math.ceil(options.timeoutMs / 1000),
        uid: options.uid,
        gid: options.uid,
        envs: {},
      });
      if (!start.id || start.error)
        throw new RuntimeError("COMMAND_START_FAILED", "远程命令未启动");
      const id = start.id;
      return {
        id,
        interrupt: () => sandbox.commands.interrupt(id),
        async wait() {
          const deadline = Date.now() + options.timeoutMs + 5000;
          let cursor: number | undefined;
          let output = "";
          for (;;) {
            const logs = await sandbox.commands.getBackgroundCommandLogs(
              id,
              cursor,
            );
            cursor = logs.cursor;
            if (logs.content) {
              output = (output + logs.content).slice(-2_000_000);
              options.onOutput?.(logs.content);
            }
            const status = await sandbox.commands.getCommandStatus(id);
            if (!status.running) {
              // The process may print after our first log read but before the
              // status request reports completion. Drain once after exit.
              const finalLogs = await sandbox.commands.getBackgroundCommandLogs(
                id,
                cursor,
              );
              if (finalLogs.content) {
                output = (output + finalLogs.content).slice(-2_000_000);
                options.onOutput?.(finalLogs.content);
              }
              return {
                exitCode: status.exitCode ?? 1,
                stdoutTail: output,
                stderrTail: status.error ?? "",
              };
            }
            if (Date.now() > deadline)
              throw new RuntimeError(
                "COMMAND_TIMEOUT",
                "远程命令超时，必须清理候选沙箱",
              );
            await new Promise((resolve) => setTimeout(resolve, 180));
          }
        },
      };
    },
    read: (path) => sandbox.files.readBytes(path),
    write: (path, data) =>
      sandbox.files.writeFiles([{ path, data, mode: 600 }]),
  };
}
interface Resource {
  connection: SandboxConnection;
  handle: WorkspaceHandle;
  state: "active" | "destroying" | "destroyed" | "cleanup_pending";
  writable: boolean;
  cleanup?: Promise<{ confirmed: boolean }>;
  detach?: () => void;
}
export function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new RuntimeError("INVALID_ARGUMENT", "参数包含空字符");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function sourcePath(path: string): string {
  const parts = path.split("/");
  if (
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.startsWith(".env") ||
        [".git", "node_modules", "dist", "id_rsa", "id_ed25519"].includes(p),
    ) ||
    /\.(pem|key)$/i.test(path)
  )
    throw new RuntimeError(
      "INVALID_SOURCE_PATH",
      "仅允许工作区内非敏感源码路径",
    );
  return path;
}
export class OpenSandboxWorkspace implements WorkspacePort {
  private readonly registered = new Map<string, Resource>();
  constructor(
    private readonly config: SandboxConfig,
    private readonly connector: SandboxConnector = realConnector,
  ) {}
  resources(): Array<{ sandboxId: string; state: Resource["state"] }> {
    return [...this.registered].map(([sandboxId, r]) => ({
      sandboxId,
      state: r.state,
    }));
  }
  async connect(handle: WorkspaceHandle): Promise<void> {
    if (this.registered.has(handle.sandboxId))
      throw new RuntimeError("SANDBOX_ALREADY_REGISTERED", "沙箱已经登记");
    if (!this.connector.connect)
      throw new RuntimeError(
        "SANDBOX_CONNECT_UNAVAILABLE",
        "沙箱连接能力不可用",
      );
    const connection = await this.connector.connect(
      this.config,
      handle.sandboxId,
    );
    if (
      connection.sandboxId !== handle.sandboxId ||
      this.registered.has(handle.sandboxId)
    ) {
      await connection.close();
      throw new RuntimeError(
        "SANDBOX_CONNECT_REJECTED",
        "沙箱连接与登记不一致",
      );
    }
    this.registered.set(handle.sandboxId, {
      connection,
      handle: { ...handle },
      state: "active",
      writable: false,
    });
  }
  async create(input: {
    runId: string;
    signal: AbortSignal;
    onCreated?: (handle: WorkspaceHandle) => Promise<void>;
  }): Promise<WorkspaceHandle> {
    if (input.signal.aborted) throw new RuntimeError("CANCELLED", "探针已取消");
    const connection = await this.connector.create(this.config, input.runId);
    const lifetimeMs = Math.min(
      Math.max(this.config.lifetimeMs ?? 900_000, 60_000),
      1_800_000,
    );
    const handle = {
      sandboxId: connection.sandboxId,
      expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
    };
    this.registered.set(handle.sandboxId, {
      connection,
      handle,
      state: "active",
      writable: true,
    });
    const resource = this.requireResource(handle);
    const onAbort = () => {
      void this.destroy(handle);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    resource.detach = () => input.signal.removeEventListener("abort", onAbort);
    try {
      try {
        await input.onCreated?.(handle);
      } catch {
        throw new RuntimeError(
          "SANDBOX_REGISTRATION_FAILED",
          "沙箱登记失败，停止使用并清理远端资源",
        );
      }
      if (input.signal.aborted)
        throw new RuntimeError("CANCELLED", "迟到创建已取消");
      await connection.renew(Math.ceil(lifetimeMs / 1000));
      if (input.signal.aborted)
        throw new RuntimeError("CANCELLED", "创建期间取消");
      return handle;
    } catch (error) {
      const cleanup = await this.destroy(handle);
      if (!cleanup.confirmed)
        throw new RuntimeError("CLEANUP_PENDING", "沙箱清理尚未确认");
      throw error;
    }
  }
  async initialize(
    handle: WorkspaceHandle,
    files: Record<string, string>,
    helper: string,
  ): Promise<void> {
    this.assertWritable(handle);
    const r = this.requireResource(handle);
    const setup = await this.executeService(
      handle,
      "mkdir -p /workspace/app /opt/pivloom /tmp/pivloom-io && chmod 700 /tmp/pivloom-io && chown 1000:1000 /workspace/app",
      { uid: 0 },
    );
    if (setup.exitCode !== 0)
      throw new RuntimeError("WORKSPACE_SETUP_FAILED", "无法初始化源码目录");
    await r.connection.write("/opt/pivloom/source-io.mjs", Buffer.from(helper));
    await this.executeService(handle, "chmod 500 /opt/pivloom/source-io.mjs", {
      uid: 0,
    });
    for (const [path, content] of Object.entries(files))
      await this.write(handle, path, Buffer.from(content));
  }
  async read(
    handle: WorkspaceHandle,
    relativePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const r = await this.io(
      handle,
      { op: "read", path: sourcePath(relativePath) },
      options,
    );
    options.signal?.throwIfAborted();
    if (typeof r.data !== "string")
      throw new RuntimeError("INVALID_FILE_RESPONSE", "源码响应格式错误");
    return Buffer.from(r.data, "base64");
  }
  async write(
    handle: WorkspaceHandle,
    relativePath: string,
    data: Uint8Array,
  ): Promise<void> {
    this.assertWritable(handle);
    sourcePath(relativePath);
    if (data.byteLength > 512 * 1024)
      throw new RuntimeError("SOURCE_LIMIT", "单个源码文件不能超过 512 KiB");
    await this.io(handle, {
      op: "write",
      path: relativePath,
      data: Buffer.from(data).toString("base64"),
    });
  }
  async listSourceFiles(
    handle: WorkspaceHandle,
    options: { signal?: AbortSignal } = {},
  ): Promise<SourceFile[]> {
    const r = await this.io(handle, { op: "list" }, options);
    options.signal?.throwIfAborted();
    if (!Array.isArray(r.files))
      throw new RuntimeError("INVALID_FILE_RESPONSE", "源码列表格式错误");
    const files: SourceFile[] = [];
    for (const path of r.files) {
      if (typeof path !== "string")
        throw new RuntimeError("INVALID_FILE_RESPONSE", "源码路径格式错误");
      const content = await this.read(handle, path, options);
      options.signal?.throwIfAborted();
      files.push({
        path,
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    return files;
  }
  async exec(
    handle: WorkspaceHandle,
    command: RemoteCommand,
  ): Promise<CommandHandle> {
    this.assertWritable(handle);
    if (command.signal?.aborted)
      throw new RuntimeError("CANCELLED", "命令已取消");
    const p = await this.requireResource(handle).connection.run(
      command.command,
      {
        uid: 1000,
        cwd: "/workspace/app",
        timeoutMs: Math.min(command.timeoutMs ?? 60_000, 120_000),
        onOutput: command.onOutput,
      },
    );
    const cancel = () => this.destroy(handle);
    const onAbort = () => {
      void cancel();
    };
    command.signal?.addEventListener("abort", onAbort, { once: true });
    if (command.signal?.aborted) await cancel();
    return {
      id: p.id,
      cancel,
      wait: async () => {
        try {
          const r = await p.wait();
          if (command.signal?.aborted)
            throw new RuntimeError("CANCELLED", "命令已取消");
          return {
            ...r,
            stdoutTail: r.stdoutTail.slice(-16000),
            stderrTail: r.stderrTail.slice(-8000),
          };
        } catch (e) {
          await this.destroy(handle);
          throw e;
        } finally {
          command.signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }
  async revokeWriters(handle: WorkspaceHandle): Promise<void> {
    this.requireResource(handle).writable = false;
    await this.executeService(handle, "pkill -KILL -u 1000; exit 0", {
      uid: 0,
    });
  }
  async executeService(
    handle: WorkspaceHandle,
    command: string,
    options: { uid?: number; timeoutMs?: number; background?: boolean } = {},
  ): Promise<CommandResult> {
    const p = await this.requireResource(handle).connection.run(command, {
      uid: options.uid ?? 1000,
      cwd: "/workspace",
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    return options.background
      ? { exitCode: 0, stdoutTail: p.id, stderrTail: "" }
      : p.wait();
  }
  endpoint(
    handle: WorkspaceHandle,
    port: number,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    if (![4173, 44772].includes(port))
      throw new RuntimeError("PORT_NOT_ALLOWED", "端口未获授权");
    return this.requireResource(handle).connection.endpoint(port);
  }
  async readArtifact(
    handle: WorkspaceHandle,
    name: string,
  ): Promise<Uint8Array> {
    if (!/^[a-z0-9-]+\.png$/.test(name))
      throw new RuntimeError("INVALID_ARTIFACT", "无效截图路径");
    return this.requireResource(handle).connection.read(
      `/tmp/pivloom-browser/${name}`,
    );
  }
  async writeServiceFile(
    handle: WorkspaceHandle,
    name: string,
    data: string,
  ): Promise<void> {
    if (!/^[a-z0-9-]+\.(mjs|json)$/.test(name))
      throw new RuntimeError("INVALID_SERVICE_PATH", "无效服务文件名");
    await this.requireResource(handle).connection.write(
      `/opt/pivloom/${name}`,
      Buffer.from(data),
    );
    await this.executeService(
      handle,
      `chmod 644 ${shellQuote("/opt/pivloom/" + name)}`,
      { uid: 0 },
    );
  }
  async destroy(handle: WorkspaceHandle): Promise<{ confirmed: boolean }> {
    const r = this.registered.get(handle.sandboxId);
    if (!r) throw new RuntimeError("UNKNOWN_SANDBOX", "沙箱不属于本次探针");
    if (r.state === "destroyed") return { confirmed: true };
    if (r.cleanup) return r.cleanup;
    r.state = "destroying";
    r.writable = false;
    r.cleanup = (async () => {
      try {
        try {
          await r.connection.kill();
        } catch (error) {
          if (
            !(error instanceof SandboxApiException && error.statusCode === 404)
          )
            throw error;
        }
        let confirmed = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          confirmed = !(await r.connection.isRunning());
          if (confirmed) break;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        r.state = confirmed ? "destroyed" : "cleanup_pending";
        if (confirmed) {
          r.detach?.();
          await r.connection.close().catch(() => {});
        }
        return { confirmed };
      } catch {
        r.state = "cleanup_pending";
        return { confirmed: false };
      } finally {
        r.cleanup = undefined;
      }
    })();
    return r.cleanup;
  }
  async releaseClient(handle: WorkspaceHandle): Promise<void> {
    const r = this.requireResource(handle);
    r.detach?.();
    await r.connection.close();
  }
  private async io(
    handle: WorkspaceHandle,
    request: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const staging = `/tmp/pivloom-io/${randomUUID()}.json`;
    await this.requireResource(handle).connection.write(
      staging,
      Buffer.from(JSON.stringify(request)),
    );
    options.signal?.throwIfAborted();
    const r = await this.executeService(
      handle,
      `node /opt/pivloom/source-io.mjs ${shellQuote(staging)}`,
      { uid: 0 },
    );
    options.signal?.throwIfAborted();
    if (r.exitCode !== 0)
      throw new RuntimeError(
        "SOURCE_OPERATION_FAILED",
        r.stdoutTail.slice(-800) || "远程源码操作被拒绝",
      );
    return JSON.parse(r.stdoutTail) as Record<string, unknown>;
  }
  private assertWritable(handle: WorkspaceHandle): void {
    if (!this.requireResource(handle).writable)
      throw new RuntimeError("WRITER_REVOKED", "Builder 写权限已撤销");
  }
  private requireResource(handle: WorkspaceHandle): Resource {
    const r = this.registered.get(handle.sandboxId);
    if (!r || r.state !== "active")
      throw new RuntimeError("SANDBOX_UNAVAILABLE", "沙箱不可用或正在清理");
    return r;
  }
}
