// Once a day (default 11 PM IST, or the first quiet moment after): the full exam, then question upkeep, then
// compaction; on Sundays the self-review. A newly wrong answer is traced to the commit that caused it: an
// agent's commit is reverted, a person's is only flagged.
import { createHash } from "node:crypto";
import type { Project, Question } from "./types.ts";
import type { Exam } from "./exam.ts";
import type { versions } from "./versions.ts";

type Steps = { fill(): Promise<unknown>; compact(): Promise<unknown>; review(): Promise<unknown> };

export function nightly(p: Project, ex: Exam, vs: ReturnType<typeof versions>, steps: Steps) {
  const hour = p.schedule?.hour ?? 23, tz = (p.schedule?.tzOffsetMin ?? 330) * 60_000, DAY = 86_400_000;
  const lastDue = (now = Date.now()) => { const l = new Date(now + tz), due = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), hour) - tz; return due <= now ? due : due - DAY; };
  const lastSunday = () => { let d = lastDue(); while (new Date(d + tz).getUTCDay() !== 0) d -= DAY; return d; };
  const fingerprint = (docs: Record<string, string>) => createHash("sha256").update(ex.examFiles.map((f) => docs[f]).join("\0")).digest("hex");
  let running = false;
  const exclusive = async (job: () => Promise<unknown>) => { running = true; try { await job(); } finally { running = false; } };

  const docsAt = async (rev: string) => Object.fromEntries(await Promise.all(ex.examFiles.map(async (f) => [f, (await vs.at(rev, f)) ?? ""] as const)));
  const wrong = (q: Question, r: { answers: Map<string, any> }) => { const g = ex.grade(q, r.answers.get(q.id)); return !g.right || !!g.gap; };

  function countFlaky(qs: Question[]) {
    const all = ex.questions();
    for (const q of qs) { const s = all.find((x) => x.caseId === q.caseId); if (s && ++s.flaky >= 2) Object.assign(s, { status: "retired", retiredWhy: "answered differently twice with nothing in the brain to blame: unreliable question" }); }
    ex.saveQuestions(all);
  }

  async function trace(broken: Question[], since: string): Promise<{ lines: string[]; reverted: boolean; unreliable?: boolean }> {
    const ids = broken.map((q) => q.id).join(", "), commits = await vs.since(since);
    if (!commits.length) return { lines: [`${ids} got a different answer, but nothing changed since the last exam. Treated as unreliable; nothing changed.`], reverted: false, unreliable: true };
    const fails = async (rev: string) => { const r = await ex.sit(broken, await docsAt(rev), false); return r.ok && broken.some((q) => wrong(q, r)); };
    if (!(await fails(commits[commits.length - 1].commit))) return { lines: [`${ids} got a different answer tonight but the right one when asked again. Treated as unreliable; nothing changed.`], reverted: false, unreliable: true };
    // Wrong on the brain as it was at the last exam too: nothing since then broke it.
    if (await fails(since)) return { lines: [`${ids} is also answered differently on the brain as it was at the last exam, so no recent edit caused it. Nothing changed.`], reverted: false, unreliable: true };
    let lo = 0, hi = commits.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (await fails(commits[mid].commit)) hi = mid; else lo = mid + 1; }
    const c = commits[lo], broke = `${ids} broke because of "${c.message}" (${c.commit}).`;
    if (!c.message.startsWith("agent:")) return { lines: [broke, "That edit was made by a person, so it was left in place and only flagged."], reverted: false };
    const rv = await vs.revert(c.commit, `nightly exam: it broke ${ids}`);
    return rv.ok ? { lines: [broke, `That edit was undone in ${(rv.files ?? []).join(" and ")}.`], reverted: true } : { lines: [broke, `It couldn't be undone automatically (${rv.error}), so it was left in place.`], reverted: false };
  }

  async function runFull() {
    await vs.commit("outside the loop: edits made by a person"); // so every change is a commit to trace
    const prev = ex.status().lastFull, docs = ex.currentDocs(), head = await vs.head(), qs = ex.refresh();
    if (!qs.length) { ex.saveStatus({ lastFull: { at: Date.now(), commit: head, fingerprint: fingerprint(docs), asked: 0, right: 0, results: [], note: "no exam questions yet" } }); return; }
    const r = await ex.sitAll(qs, docs, true);
    if (!r.ok) { ex.saveStatus({ lastFull: { ...(prev ?? {}), at: prev?.at ?? 0, error: (r as any).error, errorAt: Date.now() } }); return; }
    const results = qs.map((q) => { const g = ex.grade(q, r.answers.get(q.id)); return { id: q.id, unit: q.unit, source: q.source, right: g.right && !g.gap, got: g.right ? g.gap ?? "" : JSON.stringify(r.answers.get(q.id) ?? "no answer").slice(0, 120) }; });
    const wasRight = new Set((prev?.results ?? []).filter((x: any) => x.right).map((x: any) => x.id));
    const newlyWrong = qs.filter((q) => wasRight.has(q.id) && !results.find((x) => x.id === q.id)!.right);
    const actions: string[] = [];
    const soft = newlyWrong.filter((q) => !ex.blocks(q)), hard = newlyWrong.filter(ex.blocks);
    if (soft.length) actions.push(`${soft.map((q) => q.id).join(", ")} (lower-trust) got a different answer tonight. Reported only; nothing changed.`);
    let after;
    if (hard.length && prev?.commit) {
      const t = await trace(hard, prev.commit); actions.push(...t.lines);
      if (t.unreliable) countFlaky(hard);
      if (t.reverted) { const r2 = await ex.sitAll(qs, ex.currentDocs(), false); if (r2.ok) after = { at: Date.now(), asked: qs.length, right: qs.filter((q) => !wrong(q, r2)).length }; }
    }
    ex.addDoubts(r.doubts, "nightly exam");
    ex.saveStatus({ lastFull: { at: Date.now(), commit: await vs.head(), fingerprint: fingerprint(ex.currentDocs()), asked: qs.length, right: results.filter((x) => x.right).length, results, actions, after } });
  }

  async function tick() {
    if (running || !p.quiet()) return;
    const s = ex.status(), due = lastDue();
    if ((s.lastFull?.at ?? 0) < due) {
      if (s.lastFull?.fingerprint === fingerprint(ex.currentDocs())) ex.saveStatus({ lastFull: { ...s.lastFull, at: Date.now(), skipped: "nothing changed since the last exam" } });
      else await exclusive(runFull);
      return;
    }
    if ((s.lastFill?.at ?? 0) < due) return exclusive(steps.fill);
    if ((s.lastCompact?.at ?? 0) < due) return exclusive(steps.compact);
    if ((s.lastReview?.at ?? 0) < lastSunday()) return exclusive(async () => { await steps.review(); if (p.weekly) ex.saveStatus({ lastWeekly: { at: Date.now(), lines: await p.weekly() } }); });
  }
  const start = () => { setInterval(() => { tick().catch((e) => console.error(`[brain:${p.name}]`, e.message)); }, 15 * 60_000); setTimeout(() => { tick().catch(() => {}); }, 60_000); };
  return { start, tick, runFull, trace };
}
