import { afterEach, expect, it, vi } from "vitest";
import { readDraft, saveDraft } from "./drafts";

afterEach(() => { sessionStorage.clear(); vi.resetModules(); });

it("restores an unsent draft after the page module reloads, only for its owner and project", async () => {
  saveDraft("owner-a", "project-one", "活动报名管理页面");
  saveDraft("owner-a", "project-two", "读书清单");
  vi.resetModules();
  const reloaded = await import("./drafts");
  expect(reloaded.readDraft("owner-a", "project-one")).toBe("活动报名管理页面");
  expect(reloaded.readDraft("owner-a", "project-two")).toBe("读书清单");
  expect(reloaded.readDraft("owner-b", "project-one")).toBe("");
  expect(readDraft("owner-a", "project-missing")).toBe("");
});
