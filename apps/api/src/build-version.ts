import { readFileSync } from "node:fs";

export interface ApiBuildVersion {
  component: "api";
  commit: string | null;
  builtAt: string | null;
}

/** The manifest travels inside dist; a checkout HEAD cannot change this value. */
export function readApiBuildVersion(): ApiBuildVersion {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8"));
    if (value && typeof value === "object" && "component" in value && value.component === "api"
      && "commit" in value && typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit)
      && "builtAt" in value && typeof value.builtAt === "string" && !Number.isNaN(Date.parse(value.builtAt))) {
      return { component: "api", commit: value.commit, builtAt: value.builtAt };
    }
  } catch { /* An unbuilt development checkout has no dist manifest. */ }
  return { component: "api", commit: null, builtAt: null };
}
