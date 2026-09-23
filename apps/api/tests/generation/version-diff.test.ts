import { describe, expect, test } from "vitest";
import { compareSourceBundles } from "../../src/generation/version-diff.js";
import { prepareSourceSnapshot } from "../../src/storage/source.js";

describe("complete saved-source comparison", () => {
  test("reports edits, additions, removals and exact moves across Unicode paths", () => {
    const before = prepareSourceSnapshot("test-v1", [
      { path: "src/App.tsx", content: "export const title = 'Old';\n" },
      { path: "src/removed.ts", content: "export const removed = true;\n" },
      { path: "src/old/name.ts", content: "export const moved = 1;\n" },
      { path: "src/保留/颜色.css", content: ".card { color: red; }\n" },
      { path: "src/unchanged.ts", content: "export const stable = true;\n" },
    ]).bundle;
    const after = prepareSourceSnapshot("test-v1", [
      { path: "src/App.tsx", content: "export const title = 'New';\n" },
      { path: "src/added.ts", content: "export const added = true;\n" },
      { path: "src/new/name.ts", content: "export const moved = 1;\n" },
      { path: "src/保留/颜色.css", content: ".card { color: blue; }\n" },
      { path: "src/unchanged.ts", content: "export const stable = true;\n" },
    ]).bundle;

    const result = compareSourceBundles(before, after);
    expect(result.unchangedCount).toBe(1);
    expect(result.changes.map(({ kind, from, to }) => [kind, from?.path ?? null, to?.path ?? null])).toEqual([
      ["modified", "src/App.tsx", "src/App.tsx"],
      ["added", null, "src/added.ts"],
      ["moved", "src/old/name.ts", "src/new/name.ts"],
      ["removed", "src/removed.ts", null],
      ["modified", "src/保留/颜色.css", "src/保留/颜色.css"],
    ]);
    expect(result.changes[0].patch).toContain("-export const title = 'Old';");
    expect(result.changes[0].patch).toContain("+export const title = 'New';");
    expect(result.changes[2].patch).toContain("src/new/name.ts");
    expect(result.changes[4].patch).toContain("+.card { color: blue; }");
    expect(result.changes.some((change) => change.from?.path === "src/unchanged.ts" || change.to?.path === "src/unchanged.ts")).toBe(false);
  });
});
