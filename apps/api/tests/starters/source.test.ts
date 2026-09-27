import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { starter, starterPlan, starterSlugs } from "../../src/starters/catalog.js";
import { starterSource } from "../../src/starters/source.js";
import { assertManagedDataSource } from "../../src/starters/data-contract.js";
import { REACT_TEMPLATE } from "../../src/runtime/template.js";
import type { SourceBundle } from "../../src/storage/source.js";

const require = createRequire(import.meta.url);
const dependencies = dirname(dirname(require.resolve("react/package.json")));
const tsc = require.resolve("typescript/bin/tsc");
const vite = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");

describe("deployable starter sources", () => {
  test("published data templates carry a source contract; old local-only source is refused", () => {
    const bundle = (contents: Record<string, string>): SourceBundle => ({ schemaVersion: 1, templateVersion: "test",
      files: Object.entries(contents).map(([path, content]) => ({ path, content, encoding: "utf8", sha256: "a".repeat(64) })), manifest: [] });
    for (const kind of ["event-signup", "appointments", "reading-list", "task-board"] as const) {
      const files = starterSource(kind, "应用");
      expect(() => assertManagedDataSource(bundle(files), kind)).not.toThrow();
      const old = { ...files };
      delete old["pivloom.data.json"];
      expect(() => assertManagedDataSource(bundle(old), kind)).toThrowError(/托管数据源码/);
    }
  });
  test("every listed template has a preserved incremental baseline and a real production build", () => {
    const root = mkdtempSync(join(tmpdir(), "pivloom-starter-test-"));
    try {
      for (const slug of starterSlugs) {
        const definition = starter(slug);
        expect(definition).toBeDefined();
        const plan = starterPlan(slug);
        expect(plan.behaviors).toHaveLength(5);
        expect(plan.groups).toHaveLength(5);
        const folder = join(root, slug);
        mkdirSync(join(folder, "src"), { recursive: true });
        symlinkSync(dependencies, join(folder, "node_modules"));
        const files = { ...REACT_TEMPLATE, ...starterSource(slug, definition!.title) };
        for (const [name, content] of Object.entries(files)) {
          mkdirSync(dirname(join(folder, name)), { recursive: true });
          writeFileSync(join(folder, name), content);
        }
        execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--esModuleInterop",
          "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
          "--jsx", "react-jsx", "--lib", "ES2022,DOM,DOM.Iterable", join(folder, "src/App.tsx"), join(folder, "src/main.tsx")],
        { cwd: folder, stdio: "pipe" });
        execFileSync(process.execPath, [vite, "build", "--base", "/p/12345678-1234-1234-1234-123456789012/"],
          { cwd: folder, stdio: "pipe" });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
