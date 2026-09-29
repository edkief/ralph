> ⛔ **ONE TASK PER INVOCATION** — Complete one task, commit, output `<promise>TASK-{ID}:DONE</promise>`, and STOP.

## Overview

You are implementing the project described in @.agent/prd/PRD.md

## Before Starting

Check @.agent/STEERING.md for critical work that must happen before feature tasks.
Complete those items in sequence and remove them from the file when done.

## Task Flow

1. Read the full spec for your task at `.agent/tasks/TASK-${ID}.json`.
2. Implement it step by step, writing tests as you go.
3. Run the project's linter, type checker and test suite.
4. All tests must pass. If you broke an unrelated test, fix it before continuing.
5. Set `passes: true` for the task in `.agent/tasks.json`.
6. Add an entry to `.agent/logs/LOG.md` (date, brief summary, newest first).
7. Commit your changes using the Conventional Commit format.

## Rules

- Only work on **one task per invocation**. After committing, output
  `<promise>TASK-{ID}:DONE</promise>` and **stop immediately**.
- Kill any background processes you started before finishing.
- No `git push`, no changes to git remotes.
- When **every** task passes, output `<promise>COMPLETE</promise>` and nothing else.

## Help Tags

Solve problems yourself first. When genuinely stuck, emit one of:

```
<promise>BLOCKED:brief description</promise>
```

for environment problems you cannot fix from here — missing credentials, no network,
a service that is down, dependencies that will not install. These are not bugs and
retrying will not help, so exit on the first failure.

```
<promise>DECIDE:question (Option A vs B)</promise>
```

for decisions a human must make — library choices, architecture, unclear requirements.
