> ⛔ **ONE TASK PER INVOCATION** — Complete one task, commit, output `<promise>TASK-{ID}:DONE</promise>`, and STOP.

## Overview

You are implementing the project described in @{{RALPH_DIR}}/prd/PRD.md

## Before Starting

Check @{{RALPH_DIR}}/STEERING.md for critical work that must happen before feature tasks.
Complete those items in sequence and remove them from the file when done.

## Task Flow

1. Read the full spec for your task at `{{RALPH_DIR}}/tasks/TASK-${ID}.json`.
2. Implement it step by step, writing tests as you go.
   Commit working checkpoints as you go: if time runs out, anything committed survives.
3. Run the project's linter, type checker and test suite.
4. All tests must pass. If you broke an unrelated test, fix it before continuing.
5. Set `passes: true` for the task in `{{RALPH_DIR}}/tasks.json`.
6. Add an entry to `{{RALPH_DIR}}/logs/LOG.md` (date, brief summary, newest first).
7. Commit your changes using the Conventional Commit format. If the task has a handoff in
   `{{RALPH_DIR}}/handoff/`, delete it in this commit.

## Rules

- Only work on **one task per invocation**. After committing, output
  `<promise>TASK-{ID}:DONE</promise>` and **stop immediately**.
- Kill any background processes you started before finishing.
- Ending your turn ends the session: nothing resumes you when a background job finishes. Wait
  for long commands (tests, builds) in the foreground, or poll their output, before you end.
- No `git push`, no changes to git remotes.
- Keep evidence worth keeping (a screenshot of the finished screen, a short report) in
  `{{RALPH_DIR}}/artifacts/TASK-${ID}/` and commit it with the task. Keep it small: final shots,
  not every step. Scratch output, such as a browser tool's own folder, does not belong in git.
- When **every** task passes, output `<promise>COMPLETE</promise>` and nothing else.

## Help Tags

Solve problems yourself first. When genuinely stuck, emit one of:

```
<promise>BLOCKED:brief description</promise>
```

for environment problems you cannot fix from here — missing credentials, no network,
a service that is down, dependencies that will not install. These are not bugs and
retrying will not help, so exit on the first failure.

Unfinished work is **not** `BLOCKED`. If the task needs more time, if you ran out of time or wrote a
handoff, or if only the close-out is left, end the turn without any promise tag. The next
iteration picks up from your commits and handoff, and a `BLOCKED` would stop the run for a person.

```
<promise>DECIDE:question (Option A vs B)</promise>
```

for decisions a human must make — library choices, architecture, unclear requirements.
