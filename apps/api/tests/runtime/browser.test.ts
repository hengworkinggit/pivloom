import { expect, test, vi } from "vitest";
import { RemoteBrowser } from "../../src/runtime/browser.js";
import {
  OpenSandboxWorkspace,
  type SandboxConnection,
} from "../../src/runtime/workspace.js";

// External sandbox transport fixture: the real Workspace and Browser APIs run,
// while no shell, Chromium, cloud sandbox, or model is started by these tests.
async function fixture(sessionId?: string) {
  const commands: { command: string; timeoutMs: number | undefined }[] = [];
  const state = {
    url: "http://127.0.0.1:4173/",
    text: "计费结果：200 元",
    tree: '- button "计算" [ref=e1]',
    refs: { e1: { role: "button", name: "计算" } } as Record<
      string,
      { role?: string; name?: string }
    >,
    failCommand: "",
    cliFailure: undefined as { command: string; error: string } | undefined,
    afterCommand: undefined as ((command: string) => void) | undefined,
    beforeCommand: undefined as
      | ((command: string) => Promise<void>)
      | undefined,
    png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    response: undefined as unknown,
    batchResponse: undefined as unknown,
    viewport: { width: 1280, height: 720, scrollWidth: 1280 },
    batchWait: undefined as Promise<void> | undefined,
    batchStarted: undefined as (() => void) | undefined,
    onBatchInterrupt: undefined as (() => void) | undefined,
    batchOrder: [] as string[],
  };
  let live = true;
  const connection: SandboxConnection = {
    sandboxId: "browser-fixture",
    kill: async () => {
      live = false;
    },
    isRunning: async () => live,
    renew: async () => {},
    close: async () => {},
    endpoint: async () => ({ url: "http://localhost:4173", headers: {} }),
    write: async () => {},
    read: async () => state.png,
    run: async (command, options) => {
      commands.push({ command, timeoutMs: options.timeoutMs });
      await state.beforeCommand?.(command);
      let data: Record<string, unknown> = {};
      if (command.includes("'open'")) {
        state.url = command.match(/'open' '([^']+)'$/)?.[1] ?? state.url;
      } else if (command.endsWith("'get' 'url'")) data = { url: state.url };
      else if (command.endsWith("'get' 'text' 'body'"))
        data = { text: state.text };
      else if (command.endsWith("'snapshot' '-i'"))
        data = { snapshot: state.tree, refs: state.refs };
      else if (command.includes("'set' 'viewport'")) {
        const size = command.match(/'viewport' '(\d+)' '(\d+)'$/)!;
        state.viewport = { width: Number(size[1]), height: Number(size[2]), scrollWidth: Number(size[1]) };
        data = { ...state.viewport };
      } else if (command.includes("'eval'")) data = { result: state.viewport };
      const success =
        !state.failCommand || !command.includes(state.failCommand);
      const cliFailure = state.cliFailure && command.includes(state.cliFailure.command)
        ? state.cliFailure : undefined;
      state.afterCommand?.(command);
      const batched = command.includes("'batch' '--bail'");
      if (command.endsWith("'close'")) state.batchOrder.push("close");
      if (batched) state.batchStarted?.();
      const batchResult = batched ? state.batchResponse : undefined;
      return {
        id: "fixture-command",
        interrupt: async () => {
          if (batched) {
            state.batchOrder.push("interrupt");
            state.onBatchInterrupt?.();
          }
        },
        wait: async () => {
          if (batched) await state.batchWait;
          return {
          exitCode: cliFailure || batched && Array.isArray(batchResult) && batchResult.some((item) => item.success === false) ? 1 : 0,
          stdoutTail: JSON.stringify(batched ? batchResult : cliFailure
            ? { success: false, data: null, error: cliFailure.error }
            : state.response ?? { success, data }),
          stderrTail: "",
          };
        },
      };
    },
  };
  const workspace = new OpenSandboxWorkspace(
    { baseUrl: "http://localhost:18080", apiKey: "fixture", image: "fixture" },
    { create: async () => connection },
  );
  const handle = await workspace.create({
    runId: "browser-fixture-run",
    signal: new AbortController().signal,
  });
  return {
    browser: new RemoteBrowser(workspace, handle, undefined, sessionId),
    commands,
    state,
    cleanup: () => workspace.destroy(handle),
  };
}

test('a lost blank document is recoverable without allowing any external origin',async()=>{
  const f=await fixture();
  try{
    await f.browser.open();
    f.state.url='about:blank';
    await expect(f.browser.observe()).rejects.toMatchObject({code:'BROWSER_SESSION_LOST'});
    expect((await f.browser.close()).confirmed).toBe(true);
  }finally{await f.cleanup();}
  const external=await fixture();
  try{
    await external.browser.open();
    external.state.url='https://example.invalid/';
    await expect(external.browser.observe()).rejects.toMatchObject({code:'BROWSER_ORIGIN_REJECTED'});
  }finally{await external.cleanup();}
});

function browser() {
  return new RemoteBrowser(
    new OpenSandboxWorkspace({
      baseUrl: "http://localhost:18080",
      apiKey: "fixture",
      image: "fixture",
    }),
    { sandboxId: "uncreated", expiresAt: "2030-01-01T00:00:00Z" },
  );
}

test("browser opening rejects an external origin before any remote command", async () => {
  for (const path of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/\0",
  ]) {
    await expect(browser().open(path)).rejects.toMatchObject({
      code: "BROWSER_ORIGIN_REJECTED",
    });
  }
});

test("refs from another observation or session cannot be acted on", async () => {
  await expect(
    browser().act({
      type: "click",
      ref: "e1",
      observationId: "another-session-observation",
    }),
  ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
});

test("a dynamic button removed after observation requires a fresh ref without closing the browser", async () => {
  const f = await fixture();
  try {
    f.state.tree = '- button "暂停" [ref=e1]';
    f.state.refs = { e1: { role: 'button', name: '暂停' } };
    const stale = await f.browser.open();
    f.state.cliFailure = { command: "'click'", error: 'Could not locate element with role=button name=暂停' };
    await expect(f.browser.act({ type: 'click', ref: 'e1', observationId: stale.id }))
      .rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
    f.state.cliFailure = undefined;
    f.state.tree = '- button "重新开始" [ref=e2]';
    f.state.refs = { e2: { role: 'button', name: '重新开始' } };
    const fresh = await f.browser.observe();
    expect(fresh.refs).toEqual({ e2: { role: 'button', name: '重新开始' } });
    expect(fresh.id).not.toBe(stale.id);
    await f.browser.act({ type: 'click', ref: 'e2', observationId: fresh.id });
    expect(f.commands.some(({ command }) => command.endsWith("'close'"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("unrelated agent-browser CLI failures remain blocked", async () => {
  const f = await fixture();
  try {
    const observed = await f.browser.open();
    f.state.cliFailure = { command: "'click'", error: 'Browser transport disconnected' };
    await expect(f.browser.act({ type: 'click', ref: 'e1', observationId: observed.id }))
      .rejects.toMatchObject({ code: 'BROWSER_BLOCKED' });
  } finally { await f.cleanup(); }
});

test("observations report the actual candidate URL, visible body, and bound session", async () => {
  const sessionId = "pivloom-16dc6729-e580-4965-9129-b04cb55aad6c";
  const f = await fixture(sessionId);
  try {
    const observation = await f.browser.open("/p/example/?step=result#total");
    expect(observation).toMatchObject({
      sessionId,
      url: "http://127.0.0.1:4173/p/example/?step=result#total",
      text: "计费结果：200 元",
      tree: '- button "计算" [ref=e1]',
      refs: { e1: { role: "button", name: "计算" } },
      truncated: false,
    });
    expect(f.browser.sessionId).toBe(sessionId);
    expect(f.commands.every(({ command }) => command.includes(sessionId))).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("CLI refs remain actionable when state attributes precede or follow the exact ref", async () => {
  const f = await fixture();
  try {
    f.state.tree = '- heading "活动" [level=1, ref=e4]\n- combobox "类别" [expanded=false, ref=e10]\n- option "设计" [selected, ref=e12]\n- textbox "姓名" [ref=e8, required]';
    f.state.refs = { e4:{role:'heading',name:'活动'}, e10:{role:'combobox',name:'类别'}, e12:{role:'option',name:'设计'}, e8:{role:'textbox',name:'姓名'} };
    const observation = await f.browser.open();
    expect(observation.truncated).toBe(false);
    expect(Object.keys(observation.refs).sort()).toEqual(['e10','e12','e4','e8']);
    await f.browser.act({type:'select',ref:'e10',value:'设计',observationId:observation.id});
    expect(f.commands.some(({command})=>command.endsWith("'select' '@e10' '设计'"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("a longer ref or non-ref attribute cannot grant membership to an absent ref", async () => {
  const f = await fixture();
  try {
    f.state.tree = '- button "提交" [disabled=false, ref=e10]\n- note "无引用" [notref=e1]';
    f.state.refs = {e1:{role:'button',name:'不存在'},e10:{role:'button',name:'提交'}};
    const observation = await f.browser.open();
    expect(observation.refs).toEqual({e10:{role:'button',name:'提交'}});
    expect(observation.truncated).toBe(true);
    await expect(f.browser.act({type:'click',ref:'e1',observationId:observation.id})).rejects.toMatchObject({code:'STALE_BROWSER_REF'});
    expect(f.commands.some(({command})=>command.includes("'click'"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("scroll and press use fresh observations and a fixed action timeout", async () => {
  const f = await fixture();
  try {
    const first = await f.browser.open();
    const second = await f.browser.act({
      type: "scroll",
      direction: "down",
      observationId: first.id,
    });
    expect(second.id).not.toBe(first.id);
    expect(
      f.commands.some(
        ({ command, timeoutMs }) =>
          command.endsWith("'scroll' 'down' '600'") &&
          typeof timeoutMs === "number" && timeoutMs > 0 &&
          timeoutMs <= 15000,
      ),
    ).toBe(true);
    await expect(
      f.browser.act({ type: "press", key: "Enter", observationId: first.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    await f.browser.act({
      type: "press",
      key: "Enter",
      observationId: second.id,
    });
    expect(
      f.commands.filter(({ command }) => command.endsWith("'press' 'Enter'")),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("Canvas direction and pause keys use official press with a fresh observation after each action", async () => {
  const f = await fixture();
  try {
    let observation = await f.browser.open();
    for (const key of ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Space"] as const) {
      const next = await f.browser.act({ type: "press", key, observationId: observation.id });
      expect(next.id).not.toBe(observation.id);
      expect(f.commands.some(({ command }) => command.endsWith(`'press' '${key}'`))).toBe(true);
      observation = next;
    }
  } finally {
    await f.cleanup();
  }
});

test("Enter and Backspace pass through native press and ordered batch without fabricated state", async () => {
  const f = await fixture();
  try {
    let observation = await f.browser.open();
    for (const key of ["Enter", "Backspace"] as const) {
      observation = await f.browser.act({ type: "press", key, observationId: observation.id });
      expect(f.commands.some(({ command }) => command.endsWith(`'press' '${key}'`))).toBe(true);
    }
    f.state.batchResponse = [
      { command: ["press", "Enter"], success: true, result: {} },
      { command: ["wait", "50"], success: true, result: {} },
      { command: ["press", "Backspace"], success: true, result: {} },
    ];
    const result = await f.browser.keyBatch({ observationId: observation.id, steps: [
      { key: "Enter", waitMs: 50 }, { key: "Backspace", waitMs: 0 },
    ] });
    expect(result.steps.map(({ key, success }) => [key, success])).toEqual([["Enter", true], ["Backspace", true]]);
    expect(f.commands.some(({ command }) => command.includes("'batch' '--bail'")
      && command.includes("Enter") && command.includes("Backspace"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("Canvas key batch passes JSON argv to official agent-browser and returns ordered results plus a fresh observation", async () => {
  const f = await fixture();
  try {
    const commands = [["press", "ArrowUp"], ["wait", "120"], ["press", "ArrowRight"], ["wait", "80"], ["press", "Space"]];
    f.state.batchResponse = commands.map((command) => ({ command, success: true, result: {} }));
    const before = await f.browser.open();
    const result = await f.browser.keyBatch({ observationId: before.id, steps: [
      { key: "ArrowUp", waitMs: 120 }, { key: "ArrowRight", waitMs: 80 }, { key: "Space", waitMs: 0 },
    ] });
    expect(result.steps).toEqual([
      { index: 0, key: "ArrowUp", waitMs: 120, success: true },
      { index: 1, key: "ArrowRight", waitMs: 80, success: true },
      { index: 2, key: "Space", waitMs: 0, success: true },
    ]);
    expect(result.observation.id).not.toBe(before.id);
    expect(result.observation.sessionId).toBe(f.browser.sessionId);
    expect(f.commands.some(({ command }) => command.includes("printf %s") && command.includes("'batch' '--bail'")
      && command.includes("ArrowUp") && command.includes("ArrowRight") && command.includes("Space"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("Canvas key batch bails at the first failed input and reports later steps as unexecuted", async () => {
  const f = await fixture();
  try {
    f.state.batchResponse = [
      { command: ["press", "ArrowUp"], success: true, result: {} },
      { command: ["wait", "100"], success: true, result: {} },
      { command: ["press", "ArrowRight"], success: false, error: "Synthetic input disconnect" },
    ];
    const before = await f.browser.open();
    const result = await f.browser.keyBatch({ observationId: before.id, steps: [
      { key: "ArrowUp", waitMs: 100 }, { key: "ArrowRight", waitMs: 100 }, { key: "ArrowDown", waitMs: 100 },
    ] });
    expect(result.steps.map((step) => step.success)).toEqual([true, false, false]);
    expect(result.observation.id).not.toBe(before.id);
    await expect(f.browser.keyBatch({ observationId: before.id, steps: [{ key: "Space", waitMs: 0 }] }))
      .rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
  } finally { await f.cleanup(); }
});

test("viewport resizing uses the real CLI boundary and returns measured width and overflow with fresh refs", async () => {
  const f = await fixture();
  try {
    const before = await f.browser.open();
    const resized = await f.browser.resize(390, 844);
    expect(f.commands.some(({ command }) => command.endsWith("'set' 'viewport' '390' '844'"))).toBe(true);
    expect(f.commands.some(({ command }) => command.includes("'eval'") && command.includes("document.documentElement.scrollWidth"))).toBe(true);
    expect(resized.text).toContain('width=390 height=844 scrollWidth=390');
    expect(resized.id).not.toBe(before.id);
    await expect(f.browser.act({ type: "click", ref: "e1", observationId: before.id })).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    await f.browser.act({ type: "click", ref: "e1", observationId: resized.id });
  } finally { await f.cleanup(); }
});

test("logs reject an escaped or malformed URL and close instead of reading external data", async () => {
  for (const url of [
    "https://example.com/stolen",
    "file:///etc/passwd",
    "not a URL",
  ]) {
    const f = await fixture();
    try {
      await f.browser.open();
      f.state.url = url;
      await expect(f.browser.logs()).rejects.toMatchObject({
        code: "BROWSER_ORIGIN_REJECTED",
      });
      expect(
        f.commands.some(({ command }) => command.endsWith("'errors'")),
      ).toBe(false);
      expect(
        f.commands.filter(({ command }) => command.endsWith("'close'")),
      ).toHaveLength(1);
      await expect(f.browser.observe()).rejects.toMatchObject({
        code: "BROWSER_CLOSED",
      });
      expect(await f.browser.close()).toEqual({ confirmed: true });
    } finally {
      await f.cleanup();
    }
  }
});

test("navigation during a logs command is detected before its data can be returned", async () => {
  const f = await fixture();
  try {
    await f.browser.open();
    f.state.afterCommand = (command) => {
      if (command.endsWith("'errors'"))
        f.state.url = "https://example.com/redirect";
    };
    await expect(f.browser.logs()).rejects.toMatchObject({
      code: "BROWSER_ORIGIN_REJECTED",
    });
    expect(await f.browser.close()).toEqual({ confirmed: true });
  } finally {
    await f.cleanup();
  }
});

test("unsafe browser parameters are rejected and close the bound session without executing them", async () => {
  const invalidActions = [
    { type: "eval", script: "globalThis.location = 'https://example.com'" },
    { type: "press", key: "Control+L" },
    { type: "scroll", direction: "down; touch /tmp/escape" },
    { type: "click", ref: "e1; touch /tmp/escape" },
    { type: "fill", ref: "e1", text: "--cdp=9222" },
    { type: "select", ref: "e1", value: "--session" },
    { type: "fill", ref: "e1", text: "hello\0world" },
    { type: "click", ref: "e1", outputPath: "/tmp/escape" },
  ];
  for (const action of invalidActions) {
    const f = await fixture();
    try {
      const observation = await f.browser.open();
      const before = f.commands.length;
      await expect(
        f.browser.act(
          JSON.parse(
            JSON.stringify({ ...action, observationId: observation.id }),
          ),
        ),
      ).rejects.toMatchObject({ code: "INVALID_BROWSER_ACTION" });
      expect(
        f.commands
          .slice(before)
          .map(({ command }) => command.includes("'close'")),
      ).toEqual([true]);
      await expect(f.browser.observe()).rejects.toMatchObject({
        code: "BROWSER_CLOSED",
      });
    } finally {
      await f.cleanup();
    }
  }
});

test("an unconfirmed close disables actions and can be retried for confirmation", async () => {
  const f = await fixture();
  try {
    const observation = await f.browser.open();
    f.state.failCommand = "'close'";
    expect(await f.browser.close()).toEqual({ confirmed: false });
    await expect(
      f.browser.act({
        type: "click",
        ref: "e1",
        observationId: observation.id,
      }),
    ).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
    f.state.failCommand = "";
    expect(await f.browser.close()).toEqual({ confirmed: true });
    expect(await f.browser.close()).toEqual({ confirmed: true });
    expect(
      f.commands.filter(({ command }) => command.endsWith("'close'")),
    ).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test("returned refs cannot be forged and a failed observation invalidates the old refs", async () => {
  const f = await fixture();
  try {
    const observed = await f.browser.open();
    observed.refs.e999 = { role: "button", name: "forged" };
    await expect(
      f.browser.act({ type: "click", ref: "e999", observationId: observed.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    f.state.failCommand = "'snapshot'";
    await expect(f.browser.observe()).rejects.toMatchObject({
      code: "BROWSER_BLOCKED",
    });
    await expect(
      f.browser.act({ type: "click", ref: "e1", observationId: observed.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    expect(f.commands.some(({ command }) => command.includes("'click'"))).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("a changed page invalidates old refs and a failed post-action observation never replays the action", async () => {
  const f = await fixture();
  try {
    const observed = await f.browser.open();
    f.state.url = "http://127.0.0.1:4173/another-page";
    await expect(
      f.browser.act({ type: "click", ref: "e1", observationId: observed.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    const fresh = await f.browser.observe();
    f.state.failCommand = "'snapshot'";
    await expect(
      f.browser.act({ type: "click", ref: "e1", observationId: fresh.id }),
    ).rejects.toMatchObject({ code: "BROWSER_BLOCKED" });
    await expect(
      f.browser.act({ type: "click", ref: "e1", observationId: fresh.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
    expect(
      f.commands.filter(({ command }) => command.includes("'click'")),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("large observations declare truncation and expose only bounded valid refs visible in their tree", async () => {
  const f = await fixture();
  try {
    f.state.text = "界".repeat(13000);
    f.state.tree =
      Array.from(
        { length: 120 },
        (_, index) => `- button "${index}" [ref=e${index + 1}]`,
      ).join("\n") + "x".repeat(13000);
    f.state.refs = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `e${index + 1}`,
        { role: "button", name: "n".repeat(500) },
      ]),
    );
    f.state.refs.e999 = { role: "button", name: "not in the observed tree" };
    const observed = await f.browser.open();
    expect(observed.truncated).toBe(true);
    expect(observed.text).toBe("界".repeat(12000));
    expect(observed.tree.length).toBeLessThanOrEqual(12000);
    expect(Object.keys(observed.refs)).toHaveLength(100);
    expect(observed.refs.e1.name?.length).toBeLessThanOrEqual(160);
    expect(observed.refs.e999).toBeUndefined();
    await expect(
      f.browser.act({ type: "click", ref: "e999", observationId: observed.id }),
    ).rejects.toMatchObject({ code: "STALE_BROWSER_REF" });
  } finally {
    await f.cleanup();
  }
});

test("text and screenshots reject navigation that happens while evidence is being read", async () => {
  for (const operation of ["text", "screenshot"] as const) {
    const f = await fixture();
    try {
      await f.browser.open();
      f.state.afterCommand = (command) => {
        if (
          operation === "text"
            ? command.endsWith("'get' 'text' 'body'")
            : command.includes("'screenshot'")
        )
          f.state.url = "https://example.com/escaped";
      };
      await expect(f.browser[operation]()).rejects.toMatchObject({
        code: "BROWSER_ORIGIN_REJECTED",
      });
      expect(await f.browser.close()).toEqual({ confirmed: true });
    } finally {
      await f.cleanup();
    }
  }
});

test("screenshots are restricted to a controlled PNG of at most 2 MiB", async () => {
  const f = await fixture();
  try {
    await f.browser.open();
    const screenshot = await f.browser.screenshot();
    expect(screenshot.mimeType).toBe("image/png");
    expect(Buffer.from(screenshot.base64, "base64")).toEqual(
      Buffer.from(f.state.png),
    );
    f.state.png = new Uint8Array(2 * 1024 * 1024 + 1);
    f.state.png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    await expect(f.browser.screenshot()).rejects.toMatchObject({
      code: "INVALID_SCREENSHOT",
    });
  } finally {
    await f.cleanup();
  }
});

test("overlapping actions cannot consume the same observation twice", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const observed = await f.browser.open();
    f.state.beforeCommand = async (command) => {
      if (command.endsWith("'get' 'url'")) {
        entered();
        await gate;
      }
    };
    const first = f.browser.act({
      type: "click",
      ref: "e1",
      observationId: observed.id,
    });
    await waiting;
    const second = f.browser.act({
      type: "click",
      ref: "e1",
      observationId: observed.id,
    });
    // Capture without waiting for the held external command; no second action may start.
    let rejectedCode: string | undefined;
    const settled = second.catch((error: { code?: string }) => {
      rejectedCode = error.code;
    });
    await Promise.resolve();
    release();
    await Promise.all([first, settled]);
    expect(rejectedCode).toBe("BROWSER_BUSY");
    expect(
      f.commands.filter(({ command }) => command.includes("'click'")),
    ).toHaveLength(1);
  } finally {
    release();
    await f.cleanup();
  }
});

test("only an explicit successful CLI envelope confirms close", async () => {
  const f = await fixture();
  try {
    await f.browser.open();
    f.state.response = { success: "true", data: {} };
    expect(await f.browser.close()).toEqual({ confirmed: false });
    f.state.response = undefined;
    expect(await f.browser.close()).toEqual({ confirmed: true });
  } finally {
    await f.cleanup();
  }
});

test("the whole observation shares one 15 second budget and closes on expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const f = await fixture();
  try {
    f.state.beforeCommand = async (command) => {
      if (!command.endsWith("'close'")) vi.setSystemTime(Date.now() + 6000);
    };
    await expect(f.browser.observe()).rejects.toMatchObject({
      code: "BROWSER_TIMEOUT",
    });
    expect(
      f.commands
        .filter(({ command }) => !command.endsWith("'close'"))
        .map(({ timeoutMs }) => timeoutMs),
    ).toEqual([15000, 9000, 3000]);
    expect(await f.browser.close()).toEqual({ confirmed: true });
    await expect(f.browser.observe()).rejects.toMatchObject({
      code: "BROWSER_CLOSED",
    });
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});

test("an escaped session cannot hide the escape by opening the preview again", async () => {
  const f = await fixture();
  try {
    await f.browser.open();
    const before = f.commands.length;
    f.state.url = "https://example.com/escaped";
    await expect(f.browser.open("/safe")).rejects.toMatchObject({
      code: "BROWSER_ORIGIN_REJECTED",
    });
    expect(
      f.commands
        .slice(before)
        .some(({ command }) => command.includes("'open'")),
    ).toBe(false);
    expect(await f.browser.close()).toEqual({ confirmed: true });
  } finally {
    await f.cleanup();
  }
});

test("a hanging close is bounded, stays unconfirmed, and cannot reopen actions", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  try {
    await f.browser.open();
    f.state.beforeCommand = async (command) => {
      if (command.endsWith("'close'")) await gate;
    };
    const close = f.browser.close();
    await vi.advanceTimersByTimeAsync(15000);
    let result: { confirmed: boolean } | undefined;
    void close.then((value) => {
      result = value;
    });
    await Promise.resolve();
    expect(result).toEqual({ confirmed: false });
    await expect(f.browser.observe()).rejects.toMatchObject({
      code: "BROWSER_CLOSED",
    });
    unblock();
    await close;
    f.state.beforeCommand = undefined;
    expect(await f.browser.close()).toEqual({ confirmed: true });
  } finally {
    unblock();
    vi.useRealTimers();
    await f.cleanup();
  }
});

test("close cannot be confirmed while a late browser command is still in flight", async () => {
  const f = await fixture();
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    f.state.beforeCommand = async (command) => {
      if (command.endsWith("'get' 'url'")) {
        entered();
        await gate;
      }
    };
    const observed = f.browser.observe();
    const failure = observed.catch((error: { code?: string }) => error.code);
    await waiting;
    expect(await f.browser.close()).toEqual({ confirmed: false });
    unblock();
    expect(await failure).toBe("BROWSER_CLOSED");
    f.state.beforeCommand = undefined;
    expect(await f.browser.close()).toEqual({ confirmed: true });
  } finally {
    unblock();
    await f.cleanup();
  }
});

test("closing a browser that was never used does not start a CLI or Chromium session", async () => {
  const f = await fixture();
  try {
    expect(await f.browser.close()).toEqual({ confirmed: true });
    expect(f.commands).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("closing during a hanging native key batch interrupts it before closing and never schedules later keys", async () => {
  const f = await fixture();
  let started!: () => void;
  let releaseWait!: () => void;
  const batchStarted = new Promise<void>((resolve) => { started = resolve; });
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    const observed = await f.browser.open();
    f.state.batchWait = waitGate;
    f.state.batchStarted = started;
    f.state.onBatchInterrupt = releaseWait;
    pending = f.browser.keyBatch({ observationId: observed.id, steps: [
      { key: "ArrowUp", waitMs: 1000 }, { key: "ArrowRight", waitMs: 1000 },
      { key: "ArrowDown", waitMs: 1000 },
    ] }).then(() => null, (error: { code?: string }) => error);
    await batchStarted;
    const close = await f.browser.close();
    expect(f.state.batchOrder[0]).toBe("interrupt");
    expect(f.state.batchOrder[1]).toBe("close");
    expect(close).toEqual({ confirmed: false });
    expect(await pending).toMatchObject({ code: "BROWSER_CLOSED" });
    expect(await f.browser.close()).toEqual({ confirmed: true });
    expect(f.commands.filter(({ command }) => command.includes("'batch' '--bail'"))).toHaveLength(1);
    await expect(f.browser.keyBatch({ observationId: observed.id, steps: [{ key: "Space", waitMs: 0 }] }))
      .rejects.toMatchObject({ code: "BROWSER_CLOSED" });
    await expect(f.browser.observe()).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
  } finally {
    releaseWait?.();
    await pending;
    await f.cleanup();
  }
});
