import { createHash } from "node:crypto";
import { sourcePath } from "./workspace.js";
import { RuntimeError, type SourceFile } from "./types.js";

export const SOURCE_SCHEMA_VERSION = 1;
export const REACT_TEMPLATE_VERSION = "react-vite-node24-20260922";

export function createSourceSnapshot(
  files: SourceFile[],
  templateVersion = REACT_TEMPLATE_VERSION,
) {
  const seen = new Set<string>();
  const normalized = files
    .map((file) => {
      const path = sourcePath(file.path);
      if (seen.has(path))
        throw new RuntimeError("INVALID_SOURCE_SNAPSHOT", "源码路径重复");
      seen.add(path);
      let content: string;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(file.content);
      } catch {
        throw new RuntimeError(
          "UNSUPPORTED_SOURCE_ENCODING",
          "源码必须为 UTF-8 文本",
        );
      }
      const sha256 = createHash("sha256").update(file.content).digest("hex");
      if (sha256 !== file.sha256)
        throw new RuntimeError(
          "SOURCE_HASH_MISMATCH",
          "源码摘要与实际字节不符",
        );
      return { path, encoding: "utf8" as const, content, sha256 };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bundle = {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    templateVersion,
    files: normalized,
  };
  const canonicalJson = JSON.stringify(bundle);
  return {
    bundle,
    canonicalJson,
    sourceHash: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}
