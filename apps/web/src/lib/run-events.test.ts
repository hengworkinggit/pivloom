import { expect, it } from "vitest";
import { readRunEvents } from "./run-events";

const runId = "74b24d87-1342-4d43-8c4e-f82e766a0633";
const event = (id: string) => ({ schemaVersion: 1, eventId: id, runId, attempt: 0, type: "run.phase", createdAt: "2026-09-22T00:00:00.000Z", payload: { phase: "implement" } });

it("reads chunked UTF-8 SSE and emits each increasing bigint event only once", async () => {
  const first = "9007199254740993", second = "9007199254740994";
  const wire = [event(first), event(first), event("8"), { ...event(second), payload: { message: "正在构建中文应用" } }]
    .map((item) => `id: ${item.eventId}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join("");
  const bytes = new TextEncoder().encode(wire);
  const response = new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const received: unknown[] = [];
  const cursor = await readRunEvents(response, { runId, after: "0", signal: new AbortController().signal, onEvent: (item) => received.push(item) });
  expect(received).toEqual([event(first), { ...event(second), payload: { message: "正在构建中文应用" } }]);
  expect(cursor).toBe(second);
});

it("rejects an event belonging to another run without exposing it to the workspace", async () => {
  const received: unknown[] = [];
  const wrong = { ...event("1"), runId: "4baa10a9-8dd1-4b46-aec9-848b628e4f32" };
  const response = new Response(`id: 1\ndata: ${JSON.stringify(wrong)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  await expect(readRunEvents(response, { runId, signal: new AbortController().signal, onEvent: (item) => received.push(item) })).rejects.toThrow("事件");
  expect(received).toEqual([]);
});

it("releases a silent response body as soon as the caller leaves the subscription", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  const controller = new AbortController();
  const received: unknown[] = [];
  const reading = readRunEvents(response, { runId, signal: controller.signal, onEvent: (item) => received.push(item) });
  controller.abort();
  await Promise.resolve();
  expect(cancelled).toBe(true);
  await expect(reading).resolves.toBe("0");
  expect(received).toEqual([]);
});
