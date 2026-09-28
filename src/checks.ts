// Fixed-code checks on an edit, before any exam. The project says what must never disappear; tables and
// "nothing lost" (for compaction) are the same for every project.
import type { Project } from "./types.ts";

// Ids, file:line citations, UPPER_SNAKE names and schema.table: the facts compaction must not lose.
export const DEFAULT_FACTS = /\b[A-Z]{2,5}-\d{3,}\b|[\w-]+\.(?:java|kt|ts|js|py|go|rb|sql|ya?ml):\d+(?:-\d+)?|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+_[a-z_]+\.[a-z][a-z0-9_]+\b/g;

function brokenTableRows(t: string): number {
  let bad = 0;
  for (const block of t.split(/\n(?!\|)/).map((b) => b.split("\n").filter((l) => l.startsWith("|")))) {
    const cols = (l: string) => l.replace(/\\\||`[^`]*`/g, "").split("|").length;
    if (block.length > 2) bad += block.filter((l) => cols(l) !== cols(block[0])).length;
  }
  return bad;
}

export function structureProblems(p: Project, file: string, before: string, after: string): string[] {
  const out: string[] = [];
  const had = p.protectedKeys(file, before), has = p.protectedKeys(file, after);
  const lost = [...had].filter((k) => !has.has(k));
  if (lost.length) out.push(`removes or renames ${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ", …" : ""}`);
  if (brokenTableRows(after) > brokenTableRows(before)) out.push("breaks a markdown table (a row now has a different number of columns from its header)");
  out.push(...(p.checkAdded?.(file, before, after) ?? []));
  return out;
}

// Compaction only: every fact in the old text must be in the new text or its archive, and the archive may only grow.
export function lostFacts(p: Project, before: string, after: string, archiveBefore: string, archiveAfter: string): string[] {
  if (!archiveAfter.startsWith(archiveBefore.trimEnd())) return ["the archive was changed, not only added to"];
  const re = p.factPattern ?? DEFAULT_FACTS;
  const kept = new Set([...(after + "\n" + archiveAfter).matchAll(new RegExp(re.source, "g"))].map((m) => m[0]));
  const lost = [...new Set([...before.matchAll(new RegExp(re.source, "g"))].map((m) => m[0]))].filter((x) => !kept.has(x));
  return lost.length ? [`${lost.length} fact${lost.length === 1 ? "" : "s"} would be lost (in neither the file nor its archive): ${lost.slice(0, 8).join(", ")}${lost.length > 8 ? ", …" : ""}`] : [];
}

export const archiveOf = (f: string) => f.replace(/\.md$/, "_archive.md");
