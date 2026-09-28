// Every brain edit goes through here, one at a time: the editor changes copies in a stage folder, the gate checks
// them (one retry on a fail), and only a passing edit is copied into the live files and committed.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, RunResult } from "./types.ts";
import type { Exam, GateResult } from "./exam.ts";
import type { versions } from "./versions.ts";

export type EditResult = { r: RunResult; changed: string[]; kept: string[]; exam?: GateResult; attempts: number; commit?: string; rounds: { summary: string; fix?: string }[] };
export type EditOpts = {
  label: string; prompt: (stage: string) => string; schema: object; said?: string; compaction?: boolean; tools?: "read" | "research";
  commitMsg: (decision: string, keep: boolean) => string; busy?: (s: string | undefined) => void; onKept?: (files: string[]) => void;
};

const fixPrompt = (problems: string[], broken: string) => `Your edit was checked before being kept, and it failed:
${problems.map((p) => `- ${p}`).join("\n")}${broken ? `\n- The exam: ${broken}. Those cases were handled correctly before your edit, so the edit must not change their answers.` : ""}

Fix your edit in the same copies, keeping the lesson if it's right. A claim that doesn't check out: correct it or mark it Unverified. Return your decision again.`;

export function editor(p: Project, ex: Exam, vs: ReturnType<typeof versions>) {
  const names = p.files.filter((f) => f.kind !== "log").flatMap((f) => [f.name, ...(f.kind === "knowledge" ? [f.name.replace(/\.md$/, "_archive.md")] : [])]);
  const hash = (f: string) => existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "";
  let slot: Promise<unknown> = Promise.resolve();
  const one = <T>(job: () => Promise<T>): Promise<T> => { const r = slot.then(job, job); slot = r.catch(() => {}); return r; };

  return (o: EditOpts): Promise<EditResult> => one(async () => {
    const stamp = `${o.label.replace(/\W+/g, "_").slice(0, 40)}_${Date.now()}`;
    const snap = join(p.stateDir, "snapshots", stamp), stage = join(p.stateDir, "stage", stamp);
    mkdirSync(snap, { recursive: true }); mkdirSync(stage, { recursive: true });
    const before: Record<string, string> = {};
    for (const f of names) { const src = join(p.liveDir, f); if (existsSync(src)) { copyFileSync(src, join(snap, f)); copyFileSync(src, join(stage, f)); before[f] = hash(src); } }
    // The editor is told to edit the copies; if it wrote the live files anyway, move that into the copies and restore.
    const pullStray = () => { for (const f of names) { const live = join(p.liveDir, f); if (existsSync(live) && hash(live) !== (before[f] ?? "")) { copyFileSync(live, join(stage, f)); if (existsSync(join(snap, f))) copyFileSync(join(snap, f), live); } } };
    const diff = () => names.filter((f) => existsSync(join(stage, f)) && hash(join(stage, f)) !== (before[f] ?? ""));
    const texts = (dir: string, fs: string[]) => Object.fromEntries(fs.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : ""]));
    const run = (prompt: string, resumeId?: string) => p.runner.run({ prompt, schema: o.schema, agent: p.prompts.editorAgent, edits: true, tools: o.tools ?? "read", resumeId });
    o.busy?.("Editor working on a copy of the brain");
    let r = await run(o.prompt(stage)); pullStray();
    let changed = diff(), exam: GateResult | undefined, attempts = 0;
    const rounds: EditResult["rounds"] = [];
    while (changed.length && r.ok) {
      attempts++;
      o.busy?.(attempts === 1 ? "Checking the edit" : "Checking the fix");
      exam = await ex.gate(texts(snap, changed), texts(stage, changed), o.said ?? "", { compaction: o.compaction });
      rounds.push({ summary: exam.summary });
      if (exam.ok || attempts > 1 || exam.error) break;
      o.busy?.("Editor fixing what the check found");
      const fix = fixPrompt(exam.problems, exam.broken.map((b) => `${b.id} would get ${b.got}, was ${b.expected}`).join("; "));
      r = await run(r.sessionId ? fix : `${o.prompt(stage)}\n\n${fix}`, r.sessionId);
      rounds[rounds.length - 1].fix = (r.structured?.changes ?? []).map((c: any) => c.summary).join("; ") || r.structured?.reasoning || "";
      pullStray(); changed = diff();
    }
    const keep = changed.length > 0 && !!exam?.ok;
    if (keep) for (const f of changed) copyFileSync(join(stage, f), join(p.liveDir, f));
    const c = await vs.commit(o.commitMsg(r.structured?.decision ?? "edit", keep));
    o.busy?.(undefined);
    if (keep) o.onKept?.(changed);
    return { r, changed, kept: keep ? changed : [], exam, attempts, commit: c.commit, rounds };
  });
}
