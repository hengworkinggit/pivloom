import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPublicationStore } from "../../src/generation/publication.js";

test("one release pointer switches published code and version metadata together", async () => {
  const root = await mkdtemp(join(tmpdir(), "pivloom-publication-"));
  const projectId = randomUUID();
  const projectRoot = join(root, projectId);
  const store = createPublicationStore({ root, baseUrl: "https://app.example.test", sandbox: {
    baseUrl: "https://sandbox.example.test", apiKey: "fixture", image: "fixture",
  } });
  const host = `${projectId}.app.example.test`;
  async function stage(revisionId: string, text: string) {
    const directory = join(projectRoot, "releases", revisionId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.html"), text);
    await writeFile(join(directory, ".publication.json"), JSON.stringify({ projectId, revisionId,
      sourceHash: "a".repeat(64), publishedAt: new Date().toISOString() }));
    const next = join(projectRoot, `.next-${revisionId}`);
    await symlink(directory, next);
    await rename(next, join(projectRoot, "current"));
  }
  try {
    const first = randomUUID(), second = randomUUID();
    await stage(first, "first version");
    expect((await store.get(projectId))?.revisionId).toBe(first);
    expect((await store.publicFile(host, ""))?.bytes.toString()).toBe("first version");
    await stage(second, "second version");
    expect((await store.get(projectId))?.revisionId).toBe(second);
    expect((await store.publicFile(host, ""))?.bytes.toString()).toBe("second version");
    expect(await store.publicFile(host, ".publication.json")).toBeNull();
    expect((await readFile(join(projectRoot, "current", ".publication.json"), "utf8"))).toContain(second);
    const reversible = await store.stageDelete(projectId);
    expect(await store.get(projectId)).toBeNull();
    await reversible.rollback();
    expect((await store.get(projectId))?.revisionId).toBe(second);
    const deletion = await store.stageDelete(projectId);
    await deletion.commit();
    expect(await store.get(projectId)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
