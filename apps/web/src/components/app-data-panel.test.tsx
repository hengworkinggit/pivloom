import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { createAppDataApi } from "@/lib/app-data-api";

vi.mock("@/lib/use-workspace", () => ({
  usePrivateQuery: () => ({ data: { records: [{ id: "77106c40-1286-4b91-931d-53d42154b3e5",
    collection: "registrations", name: "Alice", email: "alice@example.com", category: "创意沙龙",
    confirmed: false, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z" }],
    nextOffset: null }, error: "", refresh: vi.fn() }),
}));

test("project owner can see a private submission and confirm it from the workbench", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = { setConfirmed: vi.fn().mockResolvedValue(undefined), list: vi.fn(), remove: vi.fn(), export: vi.fn() } as unknown as ReturnType<typeof createAppDataApi>;
  const { AppDataPanel } = await import("./app-data-panel");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AppDataPanel api={api} projectId="3b8131ce-6e7a-48fd-bf71-80e9f536d7af" kind="event-signup" />));
    expect(container.textContent).toContain("alice@example.com");
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "确认");
    expect(confirm).toBeDefined();
    await act(async () => confirm!.click());
    expect(api.setConfirmed).toHaveBeenCalledWith("3b8131ce-6e7a-48fd-bf71-80e9f536d7af",
      "77106c40-1286-4b91-931d-53d42154b3e5", true);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
