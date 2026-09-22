import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";
import { createSourceStore, type SourceObjectStore } from "../../src/storage/source.js";

// In-memory object storage is an explicit external-system fixture, not a replacement for real Storage integration.
function fixtureStore() {
  const objects = new Map<string, Uint8Array>();
  const boundary: SourceObjectStore = {
    upload: async (key, value) => { objects.set(key, value); },
    download: async (key) => { if (!objects.has(key)) throw Error("fixture missing object"); return objects.get(key)!; },
    list: async () => [],
  };
  return createSourceStore({ url: "https://fixture.invalid", secret: "fixture-unused", objects: boundary });
}
const scope = () => ({ ownerId: randomUUID(), projectId: randomUUID(), revisionId: randomUUID() });

test("a UTF-8 source snapshot preserves the exact BOM and multibyte content through gzip roundtrip", async () => {
  const store = fixtureStore();
  const saved = await store.save(scope(), "fixture-template", [{ path: "README.md", content: Uint8Array.from([239, 187, 191, 228, 189, 160]) }]);
  expect(saved.sourceBytes).toBe(6);
  expect(saved.manifest[0].bytes).toBe(6);
  expect((await store.load(saved)).files[0].content).toBe("\ufeff你");
});

test("canonical hashes are independent of input ordering and revision IDs", async () => {
  const store = fixtureStore();
  const files = [{ path: "src/App.tsx", content: "export default 1" }, { path: "README.md", content: "hello" }];
  const first = await store.save(scope(), "template-v1", files);
  const second = await store.save(scope(), "template-v1", [...files].reverse());
  const differentTemplate = await store.save(scope(), "template-v2", files);
  expect(second.sourceHash).toBe(first.sourceHash);
  expect(second.key).not.toBe(first.key);
  expect(differentTemplate.sourceHash).not.toBe(first.sourceHash);
});

test("snapshot preserves a valid decomposed Unicode filename without silently renaming source", async () => {
  const store = fixtureStore();
  const path = "src/Cafe\u0301.tsx";
  const saved = await store.save(scope(), "fixture-template", [{ path, content: "export default 1" }]);
  expect(saved.manifest[0].path).toBe(path);
  expect((await store.load(saved)).files[0].path).toBe(path);
});

test.each([
  [{ path: "../private.ts", content: "secret" }],
  [{ path: "/tmp/outside.ts", content: "outside" }],
  [{ path: "src/.env.local.ts", content: "key" }],
  [{ path: "src/file.ts", content: "linked", kind: "symlink" as const }],
  [{ path: "src/binary.ts", content: Uint8Array.from([255, 254, 0]) }],
  [{ path: "image.png", content: "unsupported binary format" }],
  [{ path: "same.ts", content: "one" }, { path: "same.ts", content: "two" }],
  [{ path: "large.ts", content: "a".repeat(512 * 1024 + 1) }],
  Array.from({ length: 201 }, (_, index) => ({ path: `file${index}.ts`, content: "a" })),
  Array.from({ length: 11 }, (_, index) => ({ path: `file${index}.ts`, content: "a".repeat(512 * 1024) })),
])("snapshot rejects unsafe or unsupported source without silently discarding it %#", async (...files) => {
  await expect(fixtureStore().save(scope(), "fixture-template", files)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
});

test("a corrupt readback cannot be returned as a verified snapshot", async () => {
  const store = createSourceStore({ url: "https://fixture.invalid", secret: "unused", objects: {
    upload: async () => {}, download: async () => Uint8Array.from([1, 2, 3]), list: async () => [],
  } });
  await expect(store.save(scope(), "fixture-template", [{ path: "README.md", content: "hello" }])).rejects.toMatchObject({ code: "SNAPSHOT_SAVE_FAILED" });
});

test("the production Supabase object adapter supplies a bounded AbortSignal to network requests", async () => {
  let received: AbortSignal | null | undefined;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    received = init?.signal;
    throw Error("external network fixture unavailable");
  });
  try {
    const store = createSourceStore({ url: "https://fixture.invalid", secret: "fixture-unused" });
    await expect(store.save(scope(), "fixture-template", [{ path: "README.md", content: "hello" }])).rejects.toMatchObject({ code: "SNAPSHOT_SAVE_FAILED" });
    expect(received).toBeInstanceOf(AbortSignal);
  } finally { network.mockRestore(); }
});

test.each(["before headers", "during body"])("a real non-responsive Storage HTTP fixture is cut off after fifteen seconds %s", async (stallAt) => {
  let received = false;
  let socketClosed = false;
  const server = createServer((request, response) => {
    received = true;
    request.socket.once("close", () => { socketClosed = true; });
    if (stallAt === "during body") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"Key":"');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let deadline: NodeJS.Timeout | undefined;
  try {
    const store = createSourceStore({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: "fixture-unused" });
    const start = Date.now();
    await expect(Promise.race([
      store.save(scope(), "fixture-template", [{ path: "README.md", content: "hello" }]),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error("storage deadline did not stop request")), 18_000); }),
    ])).rejects.toMatchObject({ code: "SNAPSHOT_SAVE_FAILED" });
    expect(received).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - start).toBeLessThan(18_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socketClosed).toBe(true);
  } finally {
    if (deadline) clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 20_000);
