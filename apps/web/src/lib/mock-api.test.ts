// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshApi() {
  vi.resetModules();
  return (await import("./mock-api")).demoApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local demo service", () => {
  it("starts with a usable session and returns detached data", async () => {
    const api = await freshApi();
    expect((await api.getSession())?.email).toBe("demo@pivloom.app");
    const projects = await api.listProjects();
    expect(projects).toHaveLength(3);
    projects[0].title = "changed outside the service";
    projects[0].messages[0].content = "changed";
    expect((await api.getProject("event-demo")).title).toBe("活动报名管理");
    expect((await api.getProject("event-demo")).messages[0].content).not.toBe(
      "changed",
    );
  });

  it("keeps stopping visible, cancels stale completion, and allows a fresh run", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    await api.startRun("event-demo", "增加统计");
    await vi.advanceTimersByTimeAsync(3_700);
    expect((await api.getProject("event-demo")).activeRun?.phase).toBe(
      "checking",
    );
    expect((await api.stopRun("event-demo")).activeRun?.phase).toBe("stopping");
    await vi.advanceTimersByTimeAsync(450);
    expect((await api.getProject("event-demo")).activeRun?.phase).toBe(
      "stopping",
    );
    await vi.advanceTimersByTimeAsync(50);
    expect((await api.getProject("event-demo")).status).toBe("stopped");
    await api.startRun("event-demo", "重新生成");
    await vi.advanceTimersByTimeAsync(1_000); // The previous run would have completed here.
    expect((await api.getProject("event-demo")).activeRun?.phase).toBe(
      "planning",
    );
    expect((await api.getProject("event-demo")).revision).toBe(
      original.revision,
    );
    await vi.advanceTimersByTimeAsync(4_200);
    expect((await api.getProject("event-demo")).revision).toBe(
      original.revision + 1,
    );
  });

  it("rejects parallel runs without duplicating messages", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    await api.startRun("event-demo", "第一次修改");
    await expect(api.startRun("event-demo", "第二次修改")).rejects.toThrow(
      "正在处理上一条需求",
    );
    expect((await api.getProject("event-demo")).messages).toHaveLength(
      original.messages.length + 1,
    );
  });

  it("keeps the successful revision and exact source when simulated review fails", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    await api.startRun("event-demo", "模拟检查失败", "failure");
    await vi.advanceTimersByTimeAsync(5_200);
    const failed = await api.getProject("event-demo");
    expect(failed.status).toBe("failed");
    expect(failed.activeRun?.activities.at(-1)?.status).toBe("failed");
    expect(failed.revision).toBe(original.revision);
    expect(failed.files).toEqual(original.files);
  });

  it("persists completed updates and restores an interrupted run as stopped", async () => {
    let api = await freshApi();
    const project = await api.createProject("我的读书清单");
    expect(project.revision).toBe(0);
    expect(project.files).toEqual([]);
    await api.startRun(project.id, "添加阅读统计");
    await vi.advanceTimersByTimeAsync(5_200);
    api = await freshApi();
    const completed = await api.getProject(project.id);
    expect(completed.kind).toBe("books");
    expect(completed.revision).toBe(1);
    expect(completed.features).toContain("stats");
    await api.startRun(project.id, "支持手机布局");
    vi.clearAllTimers(); // A browser reload destroys the old page's timers.
    api = await freshApi();
    const restored = await api.getProject(project.id);
    expect(restored.status).toBe("stopped");
    expect(restored.activeRun?.phase).toBe("stopped");
    expect(restored.revision).toBe(1);
    expect(restored.files).toEqual(completed.files);
  });

  it("restores an expired preview without a new version or generated messages", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    expect((await api.expirePreview(original.id)).status).toBe("expired");
    const restored = await api.restorePreview(original.id);
    expect(restored.status).toBe("ready");
    expect(restored.revision).toBe(original.revision);
    expect(restored.messages).toEqual(original.messages);
    expect(restored.files).toEqual(original.files);
  });

  it("notifies subscribers and respects unsubscription", async () => {
    const api = await freshApi();
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    await api.startRun("event-demo", "继续修改");
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reports storage errors instead of silently losing an accepted change", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await expect(api.startRun("event-demo", "不能保存的请求")).rejects.toThrow(
      "无法保存演示数据",
    );
    expect(await api.getProject("event-demo")).toEqual(original);
  });

  it("turns timer-time persistence errors into an explicit failed result", async () => {
    const api = await freshApi();
    const original = await api.getProject("event-demo");
    await api.startRun("event-demo", "准备修改");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const failed = await api.getProject("event-demo");
    expect(failed.status).toBe("failed");
    expect(failed.activeRun?.error).toContain("仅暂存在内存中");
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await api.getProject("event-demo")).revision).toBe(
      original.revision,
    );
  });

  it("reports corrupted persistence without overwriting the original data", async () => {
    const raw = '{"version":1,"session":null,"projects":[{"id":"broken"}]}';
    localStorage.setItem("pivloom.demo.v1", raw);
    const api = await freshApi();
    await expect(api.getSession()).rejects.toThrow("版本或格式不兼容");
    expect(localStorage.getItem("pivloom.demo.v1")).toBe(raw);
  });

  it("keeps prompts as inert data rather than executable generated source", async () => {
    const api = await freshApi();
    const prompt =
      "<script>window.__promptExecuted = true</script> ${dangerous()}";
    const project = await api.createProject(prompt, "events");
    await api.startRun(project.id, prompt);
    await vi.advanceTimersByTimeAsync(5_200);
    const result = await api.getProject(project.id);
    expect(result.messages[0].content).toBe(prompt);
    expect(
      result.files.some((file) => file.content.includes("dangerous()")),
    ).toBe(false);
    expect(
      result.files.some((file) => file.content.includes("__promptExecuted")),
    ).toBe(false);
  });

  it("persists logout and rejects invalid demo credentials", async () => {
    let api = await freshApi();
    await api.logout();
    api = await freshApi();
    expect(await api.getSession()).toBeNull();
    await expect(api.listProjects()).rejects.toThrow("请先登录");
    await expect(api.login("demo@pivloom.app", "incorrect")).rejects.toThrow(
      "账号或密码不正确",
    );
    await api.login("demo@pivloom.app", "demo1234");
    expect(await api.listProjects()).toHaveLength(3);
  });
});
