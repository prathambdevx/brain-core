// Changes the brain suggests to its own machinery (a prompt rule, a threshold, a budget, code). A person decides.
// A prompt rule is tested offline first: the exam is asked with and without it, and the scores are compared.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./types.ts";
import type { Exam } from "./exam.ts";

export type Proposal = {
  id: string; at: number; title: string; area: "prompt_rule" | "threshold" | "budget" | "code" | "process";
  change: string; why: string; evidence: string[]; expected: string; sources?: string[];
  test: { kind: "exam" | "none"; rule?: string; result?: { at: number; asked: number; baseline: number; withRule: number; changed: { id: string; before: boolean; after: boolean }[] }; note?: string };
  status: "open" | "approved" | "rejected" | "done"; decidedAt?: number; decidedNote?: string;
};
const MAX_ASKED = 30;

export function proposals(p: Project, ex: Exam) {
  const file = join(p.stateDir, "proposals.json");
  const all = (): Proposal[] => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; } };
  const save = (ps: Proposal[]) => { mkdirSync(p.stateDir, { recursive: true }); writeFileSync(file, JSON.stringify(ps, null, 1)); };

  // Ask the exam with and without the rule on the same questions and files. Only a prompt rule can be tested this way.
  async function test(rule: string) {
    const qs = ex.refresh().slice(-MAX_ASKED), docs = ex.currentDocs();
    const withRule = { ...p, exam: { ...p.exam, instructions: `${p.exam.instructions}\n\nAn extra rule being tested (apply it where it's relevant):\n${rule}` } };
    const base = await ex.sitAll(qs, docs, false);
    const { exam: exam2 } = await import("./exam.ts");
    const alt = await exam2(withRule).sitAll(qs, docs, false);
    if (!base.ok || !alt.ok) return null;
    const right = (r: typeof base, q: (typeof qs)[number]) => { const g = ex.grade(q, r.answers.get(q.id)); return g.right && !g.gap; };
    const changed = qs.map((q) => ({ id: q.id, before: right(base, q), after: right(alt, q) })).filter((c) => c.before !== c.after);
    return { at: Date.now(), asked: qs.length, baseline: qs.filter((q) => right(base, q)).length, withRule: qs.filter((q) => right(alt, q)).length, changed };
  }

  async function add(x: Omit<Proposal, "id" | "at" | "status" | "test"> & { rule?: string }) {
    const ps = all();
    if (ps.some((q) => q.status === "open" && q.title.toLowerCase() === x.title.toLowerCase())) return null; // already open
    const pr: Proposal = { ...x, id: `p${Date.now()}${ps.length}`, at: Date.now(), status: "open",
      test: x.area === "prompt_rule" && x.rule ? { kind: "exam", rule: x.rule } : { kind: "none", note: "not testable offline: it changes a threshold, a budget, code or a process, not how the knowledge is applied" } };
    if (pr.test.kind === "exam") { const r = await test(pr.test.rule!).catch(() => null); if (r) pr.test.result = r; else pr.test.note = "the offline test couldn't run"; }
    save([...all(), pr]);
    return pr;
  }
  function decide(id: string, status: "approved" | "rejected" | "done", note?: string) {
    const ps = all(), pr = ps.find((x) => x.id === id);
    if (!pr) return false;
    Object.assign(pr, { status, decidedAt: Date.now(), decidedNote: note }); save(ps);
    return true;
  }
  return { all, add, decide, test };
}
