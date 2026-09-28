# brain-core

A self-improving knowledge brain for tools built on Claude. Your project keeps its knowledge in markdown files
(a playbook, a runbook, known bugs, business rules). brain-core keeps those files correct and small on its own:
it lets agents edit them, **proves every edit against cases already solved right before keeping it**, re-checks
everything nightly and undoes what broke, compacts files that grow too big, reviews its own mistakes weekly,
and proposes (tested) changes to its own machinery for a person to approve.

It started inside Ticket Desk (Enigma support tickets at DevX) and was pulled out so any project can use it.

## The loop

```
something is learned ──▶ an editor changes a COPY ──▶ the gate ──▶ kept + committed ──▶ nightly exam ──▶ a bad edit is reverted
                                                         │
                                  fixed checks · exam of proven cases (old vs new) · second opinion
                                                         │
                                                  fails: one retry, then thrown away
```

| Piece | What it does | File |
|---|---|---|
| Versioning | Every kept edit is one commit of a versioned copy; a commit that looks like it holds a secret is refused | `src/versions.ts` |
| Fixed checks | Protected headings and table rows kept, tables not broken, project checks on added text; for compaction, nothing lost | `src/checks.ts` |
| The exam | Questions frozen from cases the project proved right; asked on the old and new files; unreliable questions retired | `src/exam.ts` |
| The gate | Fixed checks, the exam, and a second opinion that tries to prove the edit wrong | `src/exam.ts` |
| Gated edits | Every edit on a staged copy, one at a time, one retry, then kept or thrown away | `src/edit.ts` |
| Question upkeep | Every area gets questions (from an earlier case, else written from its text), kept only if answered right; at most 3 per area | `src/questions.ts` |
| Nightly | The full exam; a newly wrong answer traced to its commit; an agent's commit reverted, a person's flagged | `src/nightly.ts` |
| Compaction | A file over its size budget is shortened without losing anything (moves go to an archive, word for word) | `src/compact.ts` |
| Self-review | Weekly: reads the week's mistakes, fixes knowledge gaps through the gate, turns the rest into proposals; web research for technical questions only, cited | `src/review.ts` |
| Health | The numbers it tries to improve, with a daily snapshot for the trend | `src/health.ts` |
| Proposals | Changes to its own prompts, thresholds, budgets or code, for a person to approve; a prompt rule is tested offline on the exam first | `src/proposals.ts` |

## What it will not do on its own

- Change its own gate, exam rules, safety checks or permissions. A self-improving system's classic failure is
  making its own test easier; questions only come from proven cases and only fixed code retires them.
- Change the project's code, or anything outside its knowledge files. That's a proposal, for a person.
- Learn business rules from the web. Rules come from people; the web is for technical questions, cited, and
  treated as untrusted text.

## Using it

A project implements `Project` (`src/types.ts`): where its knowledge files live, what an "area" is, which
headings must never disappear, where proven cases come from, how an exam answer is graded, its evidence of
mistakes, its own metrics, and a `Runner` that calls Claude (with no tools, read-only tools, or read-only plus
web). Then:

```ts
import { createBrain } from "brain-core";
const brain = createBrain(myProject);
brain.start();                                   // nightly exam, upkeep, compaction, weekly self-review
await brain.edit({ label: "learned X", prompt, schema, commitMsg }); // any knowledge edit, gated
brain.health.report(); brain.proposals.all();    // for the project's own pages
```

Ticket Desk's adapter is the reference implementation. Design and trade-offs: `docs/adr/0001-brain-core.md`.

## Requirements

Bun, git, and a Claude runner (Ticket Desk's calls the Claude Code CLI headless). No other dependencies.
