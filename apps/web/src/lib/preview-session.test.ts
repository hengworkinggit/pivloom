import { expect, it, vi } from "vitest";
import { activatePrivatePreview, clearVisitedPrivatePreviews } from "./preview-session";

it("exchanges the session grant in an Authorization header, never in iframe URL", async () => {
  const revisionId = "753f8374-d88f-4399-b366-0aa544d03a2f";
  const url = "https://" + revisionId + ".preview.example.test/p/" + revisionId + "/";
  const grant = "c".repeat(64);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const result = await activatePrivatePreview({ url, revisionId, grant }, new AbortController().signal, transport);
  expect(result).toBe(url);
  expect(result).not.toContain(grant);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(url + "session");
  expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Preview " + grant);
  expect(calls[0].init.credentials).toBe("include");
  await clearVisitedPrivatePreviews(transport);
  expect(calls[1].url).toBe(url + "session/clear");
  expect(calls[1].init.credentials).toBe("include");
});

it("rejects a malformed Preview URL before sending its grant", async () => {
  const transport = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
  await expect(activatePrivatePreview({ url: "https://preview.example.test/enter/secret",
    revisionId: "753f8374-d88f-4399-b366-0aa544d03a2f", grant: "c".repeat(64) },
  new AbortController().signal, transport)).rejects.toThrow(/地址/);
  expect(transport).not.toHaveBeenCalled();
});
