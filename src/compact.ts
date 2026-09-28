// Keeps the brain from bloating the context everything reads. A file over its budget is compacted that night
// without losing anything: log files by the project's own code, knowledge files by the editor through the
// gate plus the "nothing lost" check. At most one knowledge file a night.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./types.ts";
import type { Exam } from "./exam.ts";
import type { editor } from "./edit.ts";
import type { versions } from "./versions.ts";
import { archiveOf } from "./checks.ts";

const TARGET = 0.8;
const EDIT_SCHEMA = { type: "object", additionalProperties: false, required: ["decision", "reasoning", "changes"], properties: {
  decision: { type: "string", enum: ["compacted", "nothing"] }, reasoning: { type: "string" },
  changes: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "summary"], properties: { file: { type: "string" }, summary: { type: "string" } } } } } };

const prompt = (p: Project, stage: string, file: string, kb: number, target: number) => {
  const archive = archiveOf(file);
  return `${p.prompts.context()}

${file} is ${kb} KB, over its size budget. Everything that uses this project's knowledge reads it, so its size costs tokens every time and will eventually stop the exam fitting. Compact it to about ${target} KB **without losing anything a future case needs**. Work section by section, from the largest.

Allowed moves:
1. Fold a section's dated amendments and corrections into its main text so it reads as the current rule, leaving one short dated history line per fold.
2. Move text a normal case doesn't need to ${archive}, WORD FOR WORD, under the same heading: superseded wording, long investigation stories, raw output, old evidence, history already folded in. Leave a one-line pointer: "*(history: ${archive}, § <heading>)*". Only ADD to the archive. If it doesn't exist, create it with a short header saying it is the archive of ${file}.
3. Merge a fact written in two places into one, with a pointer from the other.

Keep in the main file: every rule, step, check, warning and trap; commands and queries; names of statuses, tables, fields and files; code citations; who said a rule and their quote; every heading the file's structure depends on. Never change what a rule means; don't restyle what isn't moving.

WHERE TO WRITE: only the copies in ${stage}/ (${file}, ${archive}, and the index file if the project has one, adding a line for ${archive}). It's checked before it's kept: every id, citation and name in the old text must be in the new text or the archive; the archive may only grow; protected headings stay; past cases must get the same answers; a second opinion looks for anything that went missing. Return "compacted" with one change per section touched, or "nothing" if it can't be done safely.`;
};

export function compactor(p: Project, ex: Exam, edit: ReturnType<typeof editor>, vs: ReturnType<typeof versions>) {
  const kb = (f: string) => existsSync(join(p.liveDir, f)) ? Math.round(statSync(join(p.liveDir, f)).size / 1024) : 0;
  const sizes = () => {
    const files = p.files.filter((f) => f.budgetKb).map((f) => ({ file: f.name, kind: f.kind, kb: kb(f.name), budget: f.budgetKb!, archiveKb: kb(archiveOf(f.name)) }));
    const qKb = Math.round(JSON.stringify(ex.questions().filter((q) => q.status === "active").map((q) => q.context)).length / 1024);
    const examKb = ex.examFiles.reduce((a, f) => a + kb(f), 0);
    return { at: Date.now(), files, exam: { filesKb: examKb, questionsKb: qKb, tokens: Math.round(((examKb + qKb) * 1024) / 4) } };
  };
  async function run(): Promise<string[]> {
    const lines: string[] = [], over = p.files.filter((f) => f.budgetKb && kb(f.name) > f.budgetKb);
    for (const f of over.filter((x) => x.kind === "log")) {
      const b = kb(f.name), r = p.compactLog?.(f.name) ?? { moved: [] };
      if (!r.moved.length) { lines.push(`${f.name} is ${b} KB, over its ${f.budgetKb} KB budget, but nothing could be moved yet.`); continue; }
      const c = await vs.commit(`agent: compaction of ${f.name}, ${r.moved.length} old entries archived`);
      lines.push(`${f.name}: ${r.moved.length} old entries moved to the archive, ${b} → ${kb(f.name)} KB${c.commit ? ` (${c.commit})` : ""}.`);
    }
    const k = over.find((x) => x.kind === "knowledge");
    if (k) {
      const b = kb(k.name), target = Math.round(k.budgetKb! * TARGET);
      const g = await edit({ label: `compaction ${k.name}`, compaction: true, schema: EDIT_SCHEMA, prompt: (stage) => prompt(p, stage, k.name, b, target),
        commitMsg: (_d, keep) => keep ? `agent: compaction of ${k.name} (${b} KB, target ${target} KB)` : `compaction attempt on ${k.name}: nothing kept` });
      lines.push(`${k.name}: ${g.kept.length ? `compacted ${b} → ${kb(k.name)} KB` : `not compacted (${g.exam?.summary ?? g.r.structured?.reasoning ?? g.r.error ?? "no change"})`}.`);
      ex.recordGate({ at: Date.now(), label: `Compaction: ${k.name}`, source: "compaction", kept: g.kept.length > 0, summary: g.exam?.summary ?? "", commit: g.commit, rounds: g.rounds });
    }
    ex.saveStatus({ lastCompact: { at: Date.now(), lines }, sizes: sizes() });
    return lines;
  }
  return { sizes, run };
}
