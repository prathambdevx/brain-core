// The numbers the brain tries to improve: the core's own (exam coverage and score, how often the gate keeps an
// edit, size against budget, Claude cost) plus the project's. One snapshot a day, so the page shows the trend.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Metric, Project, Runner } from "./types.ts";
import type { Exam } from "./exam.ts";

const DAY = 86_400_000;

// Wraps the project's runner so every Claude run's cost is recorded (for cost per day on the health page).
export function costed(p: Project, runner: Runner): Runner {
  const f = join(p.stateDir, "costs.jsonl");
  return { run: async (o) => { const r = await runner.run(o); try { mkdirSync(p.stateDir, { recursive: true }); appendFileSync(f, JSON.stringify({ at: Date.now(), usd: r.costUsd ?? 0, tools: o.tools ?? "read", model: o.model ?? null }) + "\n"); } catch { /* cost is best effort */ } return r; } };
}

export function health(p: Project, ex: Exam, sizes: () => { files: { file: string; kb: number; budget: number }[]; exam: { tokens: number } }) {
  const file = join(p.stateDir, "health.json");
  const history = (): { at: number; metrics: Metric[] }[] => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; } };
  const costSince = (since: number) => { const f = join(p.stateDir, "costs.jsonl"); if (!existsSync(f)) return 0; let t = 0; for (const l of readFileSync(f, "utf8").split("\n")) { try { const e = JSON.parse(l); if (e.at >= since) t += e.usd; } catch {} } return t; };

  function current(): Metric[] {
    const units = p.units(ex.currentDocs()), qs = ex.questions().filter((q) => q.status === "active");
    const covered = new Set(qs.map((q) => q.unit)).size, s = ex.status(), last = s.lastFull, gates = (s.gates ?? []).slice(0, 30), z = sizes();
    const core: Metric[] = [
      { key: "coverage", label: "Areas with an exam question", value: units.size ? Math.round((covered / units.size) * 100) : 0, unit: "%", better: "higher", note: `${covered} of ${units.size}` },
      { key: "exam", label: "Last nightly exam right", value: last?.asked ? Math.round((last.right / last.asked) * 100) : 0, unit: "%", better: "higher", note: last?.asked ? `${last.right} of ${last.asked}` : "not run yet" },
      { key: "kept", label: "Brain edits kept (last 30)", value: gates.length ? Math.round((gates.filter((g: any) => g.kept).length / gates.length) * 100) : 0, unit: "%", better: "higher", note: `${gates.length} checked` },
      { key: "size", label: "Largest file against its budget", value: z.files.length ? Math.max(...z.files.map((f) => Math.round((f.kb / f.budget) * 100))) : 0, unit: "%", better: "lower" },
      { key: "exam_tokens", label: "What the exam reads", value: Math.round(z.exam.tokens / 1000), unit: "k tokens", better: "lower" },
      { key: "cost_day", label: "Claude cost, last 7 days, per day", value: Math.round((costSince(Date.now() - 7 * DAY) / 7) * 100) / 100, unit: "USD", better: "lower" },
    ];
    return [...core, ...p.metrics()];
  }
  // Once a day: a snapshot for the trend. Returns the metric with its value a week ago, if known.
  function snapshot() {
    const h = history();
    if (h.length && Date.now() - h[h.length - 1].at < DAY - 3_600_000) return;
    h.push({ at: Date.now(), metrics: current() }); mkdirSync(p.stateDir, { recursive: true }); writeFileSync(file, JSON.stringify(h.slice(-120)));
  }
  function report() {
    const now = current(), h = history(), week = [...h].reverse().find((x) => Date.now() - x.at >= 6 * DAY);
    return now.map((m) => ({ ...m, weekAgo: week?.metrics.find((x) => x.key === m.key)?.value }));
  }
  return { current, snapshot, report, history };
}
