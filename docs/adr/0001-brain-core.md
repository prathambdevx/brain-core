# ADR-0001: brain-core, a self-improving knowledge brain pulled out of Ticket Desk

**Status:** Experiment. The core is written and builds, but no project runs it: on 28/09/2026 Pratham decided Ticket Desk keeps its own brain, and brain-core stays a separate repo to try elsewhere later. Untested beyond building: nothing in it has run for real.
**Date:** 2026-09-28

## Context

Ticket Desk (enigma-ticket-desk, its ADR-0001) grew a "brain" over one day: the knowledge files every diagnosis
reads, edited only by agents, and every edit gated by an exam of tickets already solved right. Around it: a
nightly re-check with automatic revert, question upkeep, compaction, and a second opinion. Pratham wants it to go
further (a weekly self-review that finds its own mistakes, a health page, web research, tested proposals) and to
be reusable: *"the core logic of improving itself and finding its own mistakes, and proving which fix actually
works ... should be a core ... which I can use everywhere I use AI and Claude"*.

## Decision

1. **A separate package, `brain-core`, with a `Project` adapter** (`src/types.ts`). The core owns the loop; a
   project owns the meaning: its files, its "areas" (a playbook procedure), what must never disappear, where
   proven cases come from, how an answer is graded, its evidence of mistakes, its metrics, and how Claude is
   called. Nothing in the core names Ticket Desk, Enigma or BSC.
2. **Proven cases are the ground truth.** A question is frozen from a case the project says went right (for
   Ticket Desk, a ticket that went through as first proposed, ran cleanly and never came back). Questions from
   earlier records or written from the text are lower-trust: they warn but can't block an edit or cause a revert.
3. **Every change goes through one gate** (`edit.ts` → `exam.ts`): fixed checks, the exam on the old and new
   files for the areas the edit touched (worked out by comparing each area's text, not by the editor's own
   word), and a second opinion. One retry, then it's thrown away. Only one edit at a time.
4. **The nightly run checks everything again**, traces a newly wrong answer to its commit by binary search,
   reverts an agent's commit and only flags a person's. It won't blame a commit when the question also fails on
   the brain as it was at the last exam.
5. **The brain keeps itself small.** Size budgets per file; over budget, a log file is compacted by the project's
   code and a knowledge file by the editor through the gate, plus a fixed "nothing lost" check (every id,
   citation and name must survive in the file or its archive; the archive only grows). **A few sections per run**, the
   largest, up to about 40 KB, never the ones the project marks `keepWhole` (an index table). The first
   Ticket Desk test compacted a whole 152 KB playbook in one editor run and hit the 20-minute run limit, so nothing
   was checked or kept; smaller runs also give the second opinion a diff it can actually read. Questions capped at 3 per
   area, the exam asked in batches of 15.
6. **The weekly self-review is the part that looks for problems**, not just reacts: it reads the project's
   evidence and the brain's own record, names patterns and their cause, fixes knowledge gaps through the gate,
   and writes the rest as proposals. Web search is allowed for technical questions only, cited.
7. **Proposals, not self-modification, for its own machinery.** A prompt rule is tested offline: the exam is
   asked with and without it on the same questions and files, and the scores go on the proposal. Thresholds,
   budgets, code and process can't be tested that way and say so. A person approves.
8. **Health:** the core measures exam coverage, the last nightly score, how often edits are kept, size against
   budget, what the exam reads, and Claude cost; the project adds its own. A snapshot a day gives the trend.

## The risks this knowingly accepts

- **The whole loop rests on models judging models.** The exam, the second opinion and the self-review are all
  Claude. Fixed checks bound them (structure, citations, nothing lost), and only proven cases can block or
  revert, but a wrong-but-consistent brain can pass its own exam. The exam checks the answer to past cases, not
  that every sentence is true.
- **The self-review can be noisy.** A review that proposes too much becomes something nobody reads. It's told
  "nothing" is a fine result and capped at 5 proposals; revisit after a few weeks of real reviews.
- **Web research is a prompt-injection surface.** A page could carry instructions. The prompts say web text is
  data, a web-sourced claim still goes through the gate, and the second opinion opens the cited source. That
  lowers the risk; it doesn't remove it. Business rules never come from the web.
- **The offline test for a prompt rule is an approximation.** It adds the rule to the exam's instructions, not
  to the project's real prompts, and scores only what the exam grades. It says whether a rule helps apply the
  knowledge, not whether it helps every step of the real work.
- **Lower-trust questions are circular** when written from the text they test: they catch a change in what the
  text says to do, not a text that was wrong from the start.
- **Cost:** a gate is two exam runs and an Opus second opinion; the self-review is one Opus edit plus a gate a
  week; compaction at most one a night and only when over budget.
- **Visibility:** the repo holds only the generic engine. No project's data, prompts or knowledge go in it, so it
  can be made public; whether DevX publishes it is DevX's call.
