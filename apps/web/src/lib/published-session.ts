const visited = new Set<string>();

/** Give an owner's published origin its own HttpOnly cookie. The app receives
 * only same-origin credentials, never the platform's identity token. */
export async function activatePublishedOwner(access: { url: string; grant: string },
  transport: typeof fetch = fetch): Promise<string> {
  const target = new URL(access.url);
  if (target.protocol !== "https:" || target.pathname !== "/" || target.search || target.hash
    || target.username || target.password || !/^[a-f0-9]{64}$/.test(access.grant))
    throw new Error("已发布应用地址不正确。");
  const response = await transport(`${target.origin}/__pivloom/session`, {
    method: "POST", credentials: "include", cache: "no-store",
    headers: { Authorization: `Published ${access.grant}` },
  });
  if (!response.ok) throw new Error("应用主人授权失败，请重新打开项目。");
  visited.add(target.origin);
  return target.href;
}

export async function clearVisitedPublishedOwners(transport: typeof fetch = fetch): Promise<void> {
  const origins = [...visited];
  visited.clear();
  await Promise.allSettled(origins.map((origin) => transport(`${origin}/__pivloom/session/clear`, {
    method: "POST", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(2_000),
  })));
}
