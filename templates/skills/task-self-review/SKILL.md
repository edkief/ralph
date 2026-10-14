---
name: task-self-review
description: Review your own change against the task's spec before you mark it passing and commit. Use at the end of every task, after the tests pass and before you set "passes" to true.
---

# Review your own work before marking a task passing

Setting `passes: true` tells the loop the task is done, and nobody looks at it again before the
next task builds on it. Check it as a reviewer who has only the spec and the diff would.

## Steps

1. **See the whole change.** `git status` for new and deleted files, then `git diff HEAD` and,
   for checkpoints you already committed for this task, `git log --oneline` and `git show`.
2. **Tick off every acceptance criterion** in the task's spec, one by one, with the evidence: the
   test that covers it, or the command you ran and what it printed. A criterion you reasoned
   about but did not check is not met. If one cannot be met as written, do not mark the task
   passing; say why in your handoff, or emit `DECIDE` if a person has to choose.
3. **Tests.** New behaviour has tests that fail without your change, including the error and
   empty cases the spec names. No test is skipped, deleted or loosened to make the suite pass.
4. **Leftovers.** No debug output, commented-out code, `TODO`s you could have done, stray files,
   scratch output (a browser tool's folder, logs, temp files) or secrets in the diff.
5. **Scope.** Nothing changed that the task did not need: no drive-by refactors, renames or
   formatting churn in untouched code, no new dependency the spec did not call for. Undo it, or
   note it in the log if it was necessary.
6. **Checks.** The project's linter, type checker and full test suite ran after your last edit and
   passed. Run them again if you changed anything during this review.
7. **Docs.** If behaviour a user or developer relies on changed (commands, configuration, an API),
   the README or the docs that describe it changed with it.

Fix what you find, then go back to step 1 for the parts you touched. Only then mark the task
passing, write the log entry and commit.
