import { createTwoFilesPatch } from "diff";
import type { SourceFileInfo } from "@pivloom/contracts";
import type { SourceBundle } from "../storage/source.js";

export interface SourceChange {
  kind: "added" | "removed" | "modified" | "moved";
  from: SourceFileInfo | null;
  to: SourceFileInfo | null;
  patch: string;
}

/** Compares verified, complete snapshots rather than an event-derived list of changed paths. */
export function compareSourceBundles(before: SourceBundle, after: SourceBundle): {
  unchangedCount: number; changes: SourceChange[];
} {
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const oldInfo = new Map(before.manifest.map((file) => [file.path, file]));
  const newInfo = new Map(after.manifest.map((file) => [file.path, file]));
  const changes: SourceChange[] = [];
  const removed = [] as typeof before.files;
  const added = [] as typeof after.files;
  let unchangedCount = 0;

  const patch = (oldPath: string | null, newPath: string | null, oldContent: string, newContent: string) =>
    createTwoFilesPatch(oldPath ?? "/dev/null", newPath ?? "/dev/null", oldContent, newContent);

  for (const file of before.files) {
    const next = newFiles.get(file.path);
    if (!next) { removed.push(file); continue; }
    if (file.sha256 === next.sha256) { unchangedCount++; continue; }
    changes.push({ kind: "modified", from: oldInfo.get(file.path)!, to: newInfo.get(file.path)!,
      patch: patch(file.path, file.path, file.content, next.content) });
  }
  for (const file of after.files) if (!oldFiles.has(file.path)) added.push(file);

  // Exact-content renames are identified without inventing history from a
  // heuristic. A renamed and edited file is still completely represented as
  // one deletion plus one addition.
  const additionsByHash = new Map<string, typeof added>();
  for (const file of added) {
    const queue = additionsByHash.get(file.sha256) ?? [];
    queue.push(file);
    additionsByHash.set(file.sha256, queue);
  }
  for (const queue of additionsByHash.values()) queue.sort((a, b) => a.path.localeCompare(b.path));
  const movedTo = new Set<string>();
  for (const file of removed) {
    const moved = additionsByHash.get(file.sha256)?.shift();
    if (moved) {
      movedTo.add(moved.path);
      changes.push({ kind: "moved", from: oldInfo.get(file.path)!, to: newInfo.get(moved.path)!,
        patch: patch(file.path, moved.path, file.content, moved.content) });
    } else changes.push({ kind: "removed", from: oldInfo.get(file.path)!, to: null,
      patch: patch(file.path, null, file.content, "") });
  }
  for (const file of added) if (!movedTo.has(file.path))
    changes.push({ kind: "added", from: null, to: newInfo.get(file.path)!,
      patch: patch(null, file.path, "", file.content) });
  changes.sort((a, b) => {
    const pathA = a.to?.path ?? a.from!.path;
    const pathB = b.to?.path ?? b.from!.path;
    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
  });
  return { unchangedCount, changes };
}
