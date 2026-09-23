import type { PreviewAccessResponse } from "@pivloom/contracts";

const visited = new Set<string>();

/** Exchange a short-lived owner/session grant for the Preview origin's own
 * HttpOnly Cookie. The generated iframe receives only a credential-free URL. */
export async function activatePrivatePreview(access: PreviewAccessResponse, signal: AbortSignal,
  transport: typeof fetch = fetch): Promise<string> {
  const target = new URL(access.url);
  if (target.username || target.password || target.search || target.hash
    || target.pathname !== `/p/${access.revisionId}/`
    || !["https:", "http:"].includes(target.protocol)) throw new Error("预览地址不正确。");
  const response = await transport(`${target.href}session`, {
    method: "POST", headers: { Authorization: `Preview ${access.grant}` },
    credentials: "include", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("预览授权已失效，请重新加载项目。");
  visited.add(target.href);
  return target.href;
}

/** Browser hygiene on sign-out. Server-side auth.sessions checks remain the
 * revocation authority even if a Preview tab is closed or this fetch fails. */
export async function clearVisitedPrivatePreviews(transport: typeof fetch = fetch): Promise<void> {
  const urls = [...visited];
  visited.clear();
  await Promise.allSettled(urls.map((url) => transport(`${url}session/clear`, {
    method: "POST", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(2_000),
  })));
}
