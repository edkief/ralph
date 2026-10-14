---
name: ralph-review-plan
description: Audit an existing Ralph plan (the PRD, task specs and tasks.json) against the codebase for tasks too big for one iteration, wrong order, specs that are not self-contained or are stale, uncheckable acceptance criteria and missing prerequisites, then propose and apply fixes. Use when asked to review, check or tighten a Ralph plan, before a long unattended run, or when the loop keeps stalling, splitting or asking for decisions. Not for use inside a Ralph loop iteration.
---

# Review a Ralph plan

The loop agent works one task at a time in a fresh session that knows only the loop prompt, the
PRD and that task's spec. Review the plan as that agent would meet it. Ralph's folder is `.ralph/`
unless `ralph.config.json` sets `ralphDir`.

## Read

- `.ralph/prd/PRD.md`, `.ralph/tasks.json` and every spec in `.ralph/tasks/` it lists as not passing.
- The code each spec touches, as it is now.
- What the loop has learned, where present: `.ralph/logs/LOG.md`, handoffs in `.ralph/handoff/`,
  estimates in `.ralph/assess/`, split proposals in `.ralph/split/`, and `.ralph/decisions.jsonl`
  (blockers and decisions people answered).

## Check every unfinished task

- **Size.** Fits one iteration: one coherent change of about an hour, ending in passing tests and a
  commit. Signs it does not: several unrelated deliverables, "and" in the title, many steps across
  layers, an estimate over the threshold in `assess/`, past attempts that ran out of time.
- **Order.** It builds only on tasks listed before it in `tasks.json`. Setup (skeleton, test
  runner, linter, schema) comes before the work that needs it.
- **Self-contained.** A stranger could do it from the spec and the PRD alone: files, commands and
  conventions named, no "as discussed", no reliance on another spec's text.
- **Current.** Paths, names and described behaviour match the code now; nothing it asks for already
  exists.
- **Checkable.** Every acceptance criterion is a yes or no someone can check by running something
  or observing behaviour, and together they define done. Flag "works", "clean", "robust".
- **Decided.** No research, investigate or choose tasks, and no open question the loop would have
  to `DECIDE`.
- **Runnable.** What it needs (environment variables, services, accounts, test users) is listed in
  the PRD and verified by an earlier task, so a missing one stops the run early, not mid-feature.

Also check the plan as a whole: PRD goals with no task serving them, tasks serving no goal, specs
not listed in `tasks.json` or listed twice, and a PRD long enough to waste the loop's context.

## Report, then fix

Report findings grouped by task, most serious first, each with the fix you propose: split into
named smaller tasks, reorder, add a setup or prerequisite task, rewrite a criterion, add the
missing file or command to the spec. Ask the owner which to apply, then apply them following the
`ralph-plan` skill's file formats and revision rules:

- never change a task with `"passes": true`, nor a task with a handoff unless the owner says so;
- keep existing ids; number new tasks after the highest one;
- a dropped task loses its spec as well as its `tasks.json` entry.

Run `ralph doctor` afterwards if `ralph` is installed, and fix what it reports under `plan` and
`task list`.
