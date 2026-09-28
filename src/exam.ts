// The exam and the gate. Questions are frozen from cases the project proved right; an edit is kept only if
// the questions it could affect are answered the same on the old and new files, the fixed checks pass, and
// a second opinion finds no defect. One retry is the editor's business (edit.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Answer, Project, Question } from "./types.ts";
import { structureProblems, lostFacts, archiveOf } from "./checks.ts";
import { examSchema, examPrompt, QUOTE_SCHEMA, quotePrompt, EDIT_CHECK_SCHEMA, editCheckPrompt } from "./prompts.ts";

const MAX_ASKED = 12, BATCH = 15;
export type Doubt = { id: string; at: number; title: string; question: string; why: string; cases: string[]; units: string[]; source: string; status: "open" | "resolved" | "dismissed" };
export type GateResult = { ok: boolean; problems: string[]; broken: { id: string; expected: string; got: string }[]; asked: number; flaky: string[]; updated: string[]; warnings: string[];
  checker?: { ok: boolean; summary: string; checks: any[] }; summary: string; error?: string };

export function exam(p: Project) {
  const dir = join(p.stateDir, "exam"), file = (n: string) => join(dir, n);
  const load = <T>(n: string, d: T): T => { try { return JSON.parse(readFileSync(file(n), "utf8")); } catch { return d; } };
  const save = (n: string, v: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(file(n), JSON.stringify(v, null, 1)); };
  const examFiles = p.files.filter((f) => f.kind === "knowledge").map((f) => f.name);
  const read = (f: string) => existsSync(join(p.liveDir, f)) ? readFileSync(join(p.liveDir, f), "utf8") : "";
  const questions = () => load<Question[]>("questions.json", []);
  const saveQuestions = (qs: Question[]) => save("questions.json", qs);
  const doubts = () => load<Doubt[]>("doubts.json", []);
  const status = () => load<Record<string, any>>("status.json", { gates: [] });
  const saveStatus = (s: Record<string, unknown>) => save("status.json", { ...status(), ...s });
  const blocks = (q: Question) => q.source === "proven"; // only proven cases may block an edit; the others warn
  const grade = (q: Question, a?: Answer) => p.exam.grade(q, a);

  // New proven cases become questions; a proven question whose case no longer counts as proven is retired.
  function refresh(): Question[] {
    const qs = questions(), proven = p.provenCases(), now = new Set(proven.map((c) => c.caseId)), have = new Set(qs.map((q) => q.caseId));
    for (const q of qs) if (q.status === "active" && q.source === "proven" && !now.has(q.caseId)) Object.assign(q, { status: "retired", retiredWhy: "the case no longer counts as proven (e.g. the problem came back)" });
    for (const c of proven) if (!have.has(c.caseId)) qs.push({ ...c, status: "active", flaky: 0, addedAt: Date.now() });
    saveQuestions(qs);
    return qs.filter((q) => q.status === "active");
  }

  async function sit(qs: Question[], docs: Record<string, string>, wantDoubts: boolean) {
    const open = doubts().filter((d) => d.status === "open").map((d) => d.title);
    const r = await p.runner.run({ prompt: examPrompt(p, qs, docs, wantDoubts ? open : null), schema: examSchema(p), tools: "none" });
    if (!r.ok || !r.structured) return { ok: false as const, answers: new Map<string, Answer>(), doubts: [] as any[], error: r.error ?? "no result" };
    return { ok: true as const, answers: new Map<string, Answer>((r.structured.answers as Answer[]).map((a) => [String(a.id), a])), doubts: wantDoubts ? r.structured.doubts ?? [] : [] };
  }
  // In batches, so one call never grows with the number of questions.
  async function sitAll(qs: Question[], docs: Record<string, string>, wantDoubts: boolean) {
    const answers = new Map<string, Answer>(), found: any[] = [];
    for (let i = 0; i < qs.length; i += BATCH) {
      const r = await sit(qs.slice(i, i + BATCH), docs, wantDoubts && i === 0);
      if (!r.ok) return r;
      r.answers.forEach((a, id) => answers.set(id, a)); found.push(...r.doubts);
    }
    return { ok: true as const, answers, doubts: found };
  }

  function addDoubts(found: any[], source: string) {
    const all = doubts(), seen = new Set(all.map((d) => d.title.toLowerCase()));
    for (const d of found) if (d?.title && !seen.has(d.title.toLowerCase())) { all.push({ id: `d${Date.now()}${all.length}`, at: Date.now(), title: d.title, question: d.question, why: d.why, cases: d.cases ?? [], units: d.units ?? [], source, status: "open" }); seen.add(d.title.toLowerCase()); }
    save("doubts.json", all);
  }

  // Units whose text changed; null when text outside any unit changed (it could affect every question).
  function touched(before: Record<string, string>, after: Record<string, string>): Set<string> | null {
    const a = p.units(before), b = p.units(after), out = new Set<string>();
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.add(k);
    const strip = (docs: Record<string, string>, us: Map<string, string>) => { let t = Object.values(docs).join("\n\0"); for (const u of us.values()) t = t.replace(u, ""); return t; };
    return strip(before, a) === strip(after, b) ? out : null;
  }

  async function quoteJustifies(q: Question, got: Answer, before: Record<string, string>, after: Record<string, string>, said: string): Promise<string | null> {
    const oldLines = new Set(Object.values(before).join("\n").split("\n"));
    const added = Object.values(after).join("\n").split("\n").filter((l) => !oldLines.has(l)).join("\n").slice(0, 6000);
    const r = await p.runner.run({ prompt: quotePrompt(q, got, added, said), schema: QUOTE_SCHEMA, tools: "none" });
    return r.ok && r.structured?.justified && r.structured.quote && said.includes(r.structured.quote.slice(0, 40)) ? `${r.structured.who}: "${r.structured.quote}"` : null;
  }

  // The second opinion reads only the diff; a compaction's diff is big, so it gets more room.
  async function secondOpinion(before: Record<string, string>, after: Record<string, string>, said: string, compaction: boolean) {
    const tmp = mkdtempSync(join(tmpdir(), "brain-diff-"));
    let diff = "";
    try {
      diff = Object.keys(after).filter((f) => (before[f] ?? "") !== after[f]).map((f) => {
        writeFileSync(join(tmp, "a"), before[f] ?? ""); writeFileSync(join(tmp, "b"), after[f]);
        return `===== ${f} =====\n${Bun.spawnSync(["diff", "-U2", join(tmp, "a"), join(tmp, "b")]).stdout.toString().split("\n").slice(2).join("\n")}`;
      }).join("\n\n").slice(0, compaction ? 250_000 : 60_000);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    if (!diff.trim()) return { ok: true, blocking: [] as string[], checks: [] as any[], summary: "nothing changed" };
    const r = await p.runner.run({ prompt: editCheckPrompt(p, diff, said, compaction), schema: EDIT_CHECK_SCHEMA, tools: "research", model: "opus" });
    if (!r.ok || !r.structured) return { ok: false, blocking: [], checks: [], summary: "", error: r.error ?? "no result" };
    const blocking = r.structured.verdict === "blocking" ? (r.structured.blocking ?? []).filter(Boolean) : [];
    return { ok: !blocking.length, blocking, checks: r.structured.checks ?? [], summary: r.structured.summary ?? "" };
  }

  // before/after hold only the files the edit changed.
  async function gate(before: Record<string, string>, after: Record<string, string>, said = "", opts: { compaction?: boolean } = {}): Promise<GateResult> {
    const problems: string[] = [];
    for (const f of Object.keys(after)) {
      if (!examFiles.includes(f)) continue;
      problems.push(...structureProblems(p, f, before[f] ?? "", after[f]).map((x) => `${f}: ${x}`));
      if (opts.compaction) { const a = archiveOf(f); problems.push(...lostFacts(p, before[f] ?? "", after[f], before[a] ?? read(a), after[a] ?? read(a)).map((x) => `${f}: ${x}`)); }
    }
    const res: GateResult = { ok: false, problems, broken: [], asked: 0, flaky: [], updated: [], warnings: [], summary: "" };
    const lead = (ps: string[]) => `${ps.length === 1 ? "one problem" : `${ps.length} problems`}: ${ps[0]}${ps.length > 1 ? ", and more" : ""}`;
    if (problems.length) return { ...res, summary: lead(problems) };
    if (!Object.keys(after).some((f) => examFiles.includes(f))) return { ...res, ok: true, summary: "passed the fixed checks; no exam file changed" };
    const oldDocs = Object.fromEntries(examFiles.map((f) => [f, before[f] ?? read(f)]));
    const newDocs = { ...oldDocs, ...Object.fromEntries(Object.entries(after).filter(([f]) => examFiles.includes(f))) };
    const scope = touched(oldDocs, newDocs);
    const qs = refresh().filter((q) => !scope || scope.has(q.unit)).slice(-MAX_ASKED);
    const none = { ok: true as const, answers: new Map<string, Answer>(), doubts: [] as any[] };
    const [o, n, chk] = await Promise.all([qs.length ? sit(qs, oldDocs, false) : none, qs.length ? sit(qs, newDocs, true) : none, secondOpinion(before, after, said, !!opts.compaction)]);
    if (!o.ok || !n.ok) { const e = (o as any).error ?? (n as any).error; return { ...res, error: e, summary: `the exam couldn't run: ${e}` }; }
    if ((chk as any).error) return { ...res, error: (chk as any).error, summary: `the second opinion couldn't run: ${(chk as any).error}` };
    res.checker = { ok: chk.ok, summary: chk.summary, checks: chk.checks };
    if (!chk.ok) res.problems.push(...chk.blocking.map((b) => `second opinion: ${b}`));
    res.asked = qs.length;
    const all = questions();
    for (const q of qs) {
      const stored = all.find((x) => x.caseId === q.caseId)!;
      const go = grade(q, o.answers.get(q.id)), gn = grade(q, n.answers.get(q.id));
      if (!go.right) { res.flaky.push(q.id); if (++stored.flaky >= 2) Object.assign(stored, { status: "retired", retiredWhy: "answered wrong on the unchanged files twice: unreliable question" }); continue; }
      // A gap counts only when the old files had none, so a question the exam can't fully answer never blocks.
      const gap = go.gap ? null : gn.gap;
      if (gn.right && !gap) continue;
      const a = n.answers.get(q.id);
      const why = said && a ? await quoteJustifies(q, a, before, after, said) : null;
      if (why) { stored.history = [...(stored.history ?? []), { at: Date.now(), answer: stored.answer, why }]; const { id: _id, ...rest } = a!; stored.answer = rest; res.updated.push(q.id); continue; }
      const got = !a ? "no answer" : gn.right ? `the same, but ${gap}` : JSON.stringify(a).slice(0, 160);
      const b = { id: q.id, expected: JSON.stringify(q.answer).slice(0, 160), got };
      if (blocks(q)) res.broken.push(b); else res.warnings.push(`${q.id} (${q.source === "written" ? "written from the text" : "an earlier case"}) would get ${got}`);
    }
    saveQuestions(all);
    addDoubts(n.doubts, "gate");
    res.ok = !res.broken.length && chk.ok;
    const examLine = !qs.length ? "no exam questions cover what changed yet"
      : res.broken.length ? `${res.broken.length} of ${qs.length} past cases would now be answered differently: ${res.broken.map((b) => `${b.id} would get ${b.got}`).join("; ")}`
      : `${qs.length - res.flaky.length} of ${qs.length} questions right on both versions${res.updated.length ? `, ${res.updated.length} updated by a quoted new rule` : ""}${res.flaky.length ? `, ${res.flaky.length} unreliable skipped` : ""}`;
    res.summary = `${res.ok ? "passed" : "failed"}: ${examLine}; ${chk.ok ? "second opinion found nothing wrong" : `second opinion: ${chk.blocking[0]}`}${res.warnings.length ? `; ${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"} from lower-trust questions` : ""}`;
    return res;
  }

  const recordGate = (g: Record<string, unknown>) => saveStatus({ gates: [g, ...(status().gates ?? [])].slice(0, 30) });
  const currentDocs = () => Object.fromEntries(examFiles.map((f) => [f, read(f)]));
  return { examFiles, questions, saveQuestions, doubts, saveDoubts: (d: Doubt[]) => save("doubts.json", d), status, saveStatus, recordGate, refresh, sit, sitAll, addDoubts, gate, grade, blocks, currentDocs, read };
}
export type Exam = ReturnType<typeof exam>;
