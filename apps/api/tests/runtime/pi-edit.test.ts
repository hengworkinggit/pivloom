import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runBuilder } from "../../src/runtime/pi.js";
import type { WorkspaceHandle, WorkspacePort } from "../../src/runtime/types.js";

function response(delta: Record<string, unknown>) {
  const chunk = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "edit-fixture",
    choices: [{ index: 0, delta, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
}

test("Pi's remote edit tool applies every disjoint edit in one call", async () => {
  const handle: WorkspaceHandle = { sandboxId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const files = new Map([["src/App.tsx", Buffer.from("const title = '旧标题';\nconst label = '旧标签';\n")]]);
  const workspace: WorkspacePort = {
    create: async () => handle,
    read: async (_handle, path) => files.get(path) ?? Buffer.alloc(0),
    write: async (_handle, path, data) => { files.set(path, Buffer.from(data)); },
    listSourceFiles: async () => [],
    exec: async () => { throw Error("No shell command belongs to this edit test"); },
    destroy: async () => ({ confirmed: true }),
  };
  let requests = 0;
  const result = await runBuilder({
    workspace, handle, prompt: "修改标题和标签，保留其它源码", signal: new AbortController().signal,
    modelConfig: { provider: "edit-fixture", id: "edit-fixture", baseUrl: "https://model.invalid/v1",
      api: "openai-completions", apiKey: "fixture-only", fetch: async () => {
        requests++;
        return requests === 1 ? response({ role: "assistant", tool_calls: [{ index: 0, id: "edit-two-blocks", type: "function",
          function: { name: "edit", arguments: JSON.stringify({ path: "src/App.tsx", edits: [
            { oldText: "旧标题", newText: "新标题" }, { oldText: "旧标签", newText: "新标签" },
          ] }) } }] }) : response({ role: "assistant", content: "两处修改完成" });
      } },
  });
  expect(Buffer.from(files.get("src/App.tsx")!).toString()).toBe("const title = '新标题';\nconst label = '新标签';\n");
  expect(result.toolCalls).toMatchObject([{ name: "edit", success: true }]);
  expect(result.text).toContain("两处修改完成");
  expect(requests).toBe(2);
});
