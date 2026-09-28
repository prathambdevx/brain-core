// brain-core: a self-improving knowledge brain. createBrain(project) wires the loop; the project supplies meaning.
import type { Project } from "./types.ts";
import { versions } from "./versions.ts";
import { exam } from "./exam.ts";
import { editor } from "./edit.ts";
import { compactor } from "./compact.ts";
import { upkeep } from "./questions.ts";
import { nightly } from "./nightly.ts";
import { health, costed } from "./health.ts";
import { proposals } from "./proposals.ts";
import { selfReview } from "./review.ts";

export * from "./types.ts";
export { lostFacts, structureProblems, archiveOf, DEFAULT_FACTS } from "./checks.ts";
export type { GateResult, Doubt } from "./exam.ts";
export type { Proposal } from "./proposals.ts";

export function createBrain(project: Project) {
  const p: Project = { ...project, runner: costed(project, project.runner) };
  const vs = versions(p), ex = exam(p), edit = editor(p, ex, vs), comp = compactor(p, ex, edit, vs), up = upkeep(p, ex);
  const hl = health(p, ex, comp.sizes), props = proposals(p, ex);
  const metricsText = () => hl.report().map((m) => `- ${m.label}: ${m.value}${m.unit ? ` ${m.unit}` : ""}${m.weekAgo != null ? ` (a week ago ${m.weekAgo})` : ""}${m.note ? `, ${m.note}` : ""} [${m.better} is better]`).join("\n");
  const review = selfReview(p, ex, edit, props, metricsText);
  const night = nightly(p, ex, vs, { fill: () => up.fill(), compact: () => comp.run(), review: async () => { hl.snapshot(); await review(); } });
  return {
    project: p, versions: vs, exam: ex, edit, compaction: comp, questions: up, nightly: night, health: hl, proposals: props, selfReview: review,
    // Starts the nightly schedule and a daily health snapshot.
    start() { night.start(); hl.snapshot(); setInterval(() => hl.snapshot(), 3_600_000); },
  };
}
export type Brain = ReturnType<typeof createBrain>;
