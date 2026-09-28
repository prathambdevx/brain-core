// Keeps the exam covering every unit: a unit without a question gets one (from an earlier case, else written
// from the unit's own text), kept only if today's brain answers it right. Extras beyond 3 per unit, questions
// for units that are gone, and duplicates are retired, with the reason kept.
import type { Project, Question } from "./types.ts";
import type { Exam } from "./exam.ts";

const PER_RUN = 8, PER_UNIT = 3, RETRY_AFTER = 7 * 86_400_000;
const strip = (s: string, unit: string) => s.split(unit).join("this area"); // never hand the exam its answer

const writeSchema = (p: Project) => ({ type: "object", additionalProperties: false, required: ["usable", "why", "context", "answer"], properties: {
  usable: { type: "boolean" }, why: { type: "string" }, context: { type: "string" }, answer: p.exam.answerSchema } });

const writePrompt = (p: Project, unit: string, text: string, past: { caseId: string; note: string; context: string } | null) => `${p.prompts.context()}

Write ONE exam question for "${unit}" of this project's knowledge. The exam later checks that edits don't change how a case like this is handled.

What the knowledge says about it:
"""
${text.slice(0, 12000)}
"""
${past ? `
Build it from this real earlier case, ${past.caseId}. What was recorded about it:
"""
${past.note.slice(0, 4000)}
"""
${past.context ? `Its original context:\n"""\n${past.context.slice(0, 4000)}\n"""` : ""}
usable=false if the record shows it wasn't really handled this way, or was later found wrong.` : `
There's no earlier case, so write a realistic one where "${unit}" clearly applies and nothing else does. usable=false if the text is too vague for a clear case.`}

context: what someone would know at the start (the request, and the facts found), in plain lines. NEVER name "${unit}" or give away what to do: the exam must work it out from the knowledge.
answer: the right answer, as the exam expects it:
${p.exam.instructions}
Use "${past ? past.caseId : `${unit} (written)`}" as the id. why: one sentence on why this is a fair question.`;

export function upkeep(p: Project, ex: Exam) {
  function review(): string[] {
    const all = ex.questions(), units = p.units(ex.currentDocs()), seen = new Set<string>(), notes: string[] = [];
    const byUnit = new Map<string, Question[]>();
    for (const q of all.filter((x) => x.status === "active")) byUnit.set(q.unit, [...(byUnit.get(q.unit) ?? []), q]);
    for (const [u, qs] of byUnit) for (const q of qs.sort((a, b) => Number(ex.blocks(b)) - Number(ex.blocks(a)) || b.addedAt - a.addedAt).slice(PER_UNIT)) {
      Object.assign(q, { status: "retired", retiredWhy: `more than ${PER_UNIT} questions for ${u}; newer ones cover it` }); notes.push(`${q.id}: retired, ${u} has ${PER_UNIT} newer questions`);
    }
    for (const q of all.filter((x) => x.status === "active")) {
      const why = !units.has(q.unit) ? `${q.unit} is no longer in the knowledge` : seen.has(q.caseId) ? "a duplicate of another question on the same case" : null;
      seen.add(q.caseId);
      if (why) { Object.assign(q, { status: "retired", retiredWhy: why }); notes.push(`${q.id}: retired, ${why}`); }
    }
    ex.saveQuestions(all);
    return notes;
  }

  let chain: Promise<unknown> = Promise.resolve();
  async function fillNow(only?: string[]) {
    const notes = review(); ex.refresh();
    const units = p.units(ex.currentDocs()), all = ex.questions();
    const covered = new Set(all.filter((q) => q.status === "active").map((q) => q.unit)), used = new Set(all.map((q) => q.caseId));
    const tried: Record<string, number> = ex.status().fillTried ?? {};
    const todo = [...units.keys()].filter((u) => !covered.has(u) && (only ? only.includes(u) : Date.now() - (tried[u] ?? 0) > RETRY_AFTER)).slice(0, PER_RUN);
    const drafts: Question[] = [];
    for (const u of todo) {
      const e = p.earlierCases(u).find((x) => !used.has(x.caseId));
      const past = e ? { caseId: e.caseId, note: e.note, context: (await e.context?.().catch(() => "")) ?? "" } : null;
      const r = await p.runner.run({ prompt: writePrompt(p, u, units.get(u)!, past), schema: writeSchema(p), tools: "none" }).catch(() => null);
      const s = r?.ok ? r.structured : null;
      if (!s?.usable || !s.context) { tried[u] = Date.now(); continue; }
      const { id: _i, ...answer } = s.answer ?? {};
      drafts.push({ id: past ? past.caseId : `${u} (written)`, caseId: past ? past.caseId : `written:${u}:${Date.now()}`, unit: u, context: strip(s.context, u), answer,
        source: past ? "history" : "written", addedAt: Date.now(), status: "active", flaky: 0 });
    }
    const added: string[] = [], dropped: string[] = [];
    if (drafts.length) {
      const r = await ex.sitAll(drafts, ex.currentDocs(), false);
      for (const q of drafts) {
        const g = r.ok ? ex.grade(q, r.answers.get(q.id)) : { right: false };
        if (g.right && !g.gap) { all.push(q); added.push(`${q.id} (${q.unit})`); } else { tried[q.unit] = Date.now(); dropped.push(`${q.unit}: today's brain didn't answer it as written, so it isn't a fair question`); }
      }
      ex.saveQuestions(all);
    }
    const cov = new Set(ex.questions().filter((q) => q.status === "active").map((q) => q.unit)).size;
    ex.saveStatus({ fillTried: tried, lastFill: { at: Date.now(), added, dropped, notes, covered: cov, units: units.size } });
    return { added, dropped, notes };
  }
  // One at a time: the nightly run and a new unit both write the question file.
  const fill = (only?: string[]) => { const r = chain.then(() => fillNow(only)); chain = r.catch(() => {}); return r; };
  return { fill, review };
}
