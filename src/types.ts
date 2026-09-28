// What a project plugs into brain-core. The core owns the loop (stage → check → exam → second opinion → keep
// or throw away → nightly re-check and revert → compaction → self-review); the project owns the meaning.

// One file the brain keeps. `exam` files are sent to every exam; `log` files (a ticket tracker) are only compacted.
export interface KnowledgeFile { name: string; kind: "knowledge" | "log" | "index"; budgetKb?: number }

// A case proven right, frozen into an exam question. `answer` is whatever the project's grade() understands.
export interface Question {
  id: string; caseId: string; unit: string; context: string; answer: Record<string, unknown>;
  source: "proven" | "history" | "written"; addedAt: number; status: "active" | "retired"; flaky: number; retiredWhy?: string;
  history?: { at: number; answer: Record<string, unknown>; why: string }[];
}
export type Answer = { id: string; [k: string]: unknown };
export type Grade = { right: boolean; gap?: string }; // gap: right area, but part of the answer missing

// A mistake or correction the self-review reads: a person stepping in, a failed check, a reverted edit.
export interface Evidence { at: number; ref: string; unit?: string; kind: string; detail: string }
export interface Metric { key: string; label: string; value: number; unit?: string; better: "higher" | "lower"; note?: string }

export interface RunOpts {
  prompt: string; schema?: object; model?: string; agent?: string; resumeId?: string;
  edits?: boolean;   // may edit files (only the stage folder, by instruction)
  tools?: "none" | "read" | "research"; // none: tool-less judge; read: files + read-only data; research: plus the web
}
export interface RunResult { ok: boolean; text: string; structured: any; sessionId?: string; error?: string; costUsd?: number }
export interface Runner { run(o: RunOpts): Promise<RunResult> }

export interface Project {
  name: string;
  liveDir: string;          // where the project's sessions read the knowledge files
  repoDir: string;          // git repo the versioned copy is committed in
  brainDir: string;         // versioned copy inside repoDir
  stateDir: string;         // brain-core's own state: questions, results, proposals
  files: KnowledgeFile[];
  runner: Runner;
  quiet(): boolean;         // nothing busy: safe to run the nightly work

  // The "areas" knowledge is organised in (a playbook procedure, a runbook section), with their text.
  units(text: Record<string, string>): Map<string, string>;
  // Keys that must never disappear from a file (a heading, a table row). Compared before vs after.
  protectedKeys(file: string, text: string): Set<string>;
  // Optional fixed check on added text (e.g. every new code citation must exist). Returns problems.
  checkAdded?(file: string, before: string, after: string): string[];
  factPattern?: RegExp;     // ids, citations and names compaction must not lose; a sensible default exists

  // The exam: proven cases from the project, earlier cases it can build from, and how answers are graded.
  provenCases(): Omit<Question, "status" | "flaky" | "addedAt">[];
  earlierCases(unit: string): { caseId: string; note: string; context?: () => Promise<string> }[];
  exam: { instructions: string; answerSchema: object; grade(q: Question, a?: Answer): Grade };

  // Prompts that carry the project's own words; the core adds the loop's rules around them.
  prompts: { context(): string; editorAgent?: string };

  // Self-review and health.
  evidence(sinceMs: number): Evidence[];
  metrics(): Metric[];

  // Optional: shrink a "log" file over budget (e.g. move old rows to its archive word for word). Code, not a model.
  compactLog?(file: string): { moved: string[] };
  schedule?: { hour: number; tzOffsetMin: number }; // nightly run time; default 23:00 IST
  weekly?(): Promise<string[]>; // optional extra weekly job after the self-review (e.g. a project's own cleanup)
}
