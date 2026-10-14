---
name: ralph-plan
description: Write or revise the plan Ralph's agent loop implements, the PRD, one spec per task and the run order in tasks.json, with the project's owner. Use when asked to plan a project or feature for Ralph, add or change Ralph tasks, or turn an idea or ticket into Ralph tasks. Not for use inside a Ralph loop iteration or the `ralph init` interview, which have their own instructions.
---

# Planning for Ralph

Ralph runs a coding agent in a loop. Each iteration starts a **fresh session with no memory** of
earlier ones: the agent reads the loop prompt, the PRD and the spec of **one** task, implements it,
runs the tests, marks the task passing and commits. The loop agent is often a cheaper model than
you, so the plan is where the hard thinking happens: anything you leave vague, it will guess.

Ralph's folder is `.ralph/`, unless `ralph.config.json` at the project root sets `ralphDir`. Paths
below use `.ralph/`.

## Rules for a plan the loop can run

- **Every task spec stands on its own.** Name the files, commands and conventions that matter.
  Never rely on "as discussed" or on another task's spec.
- **Every task fits one iteration**: one coherent change of roughly an hour of focused work, ending
  with passing tests and a commit. Split anything bigger.
- **Order tasks so each builds only on tasks before it.** On a new project, the first task sets up
  the skeleton, test runner and linter, so later tasks have something to verify with.
- **Acceptance criteria are checkable** by running something or observing behaviour, each one a
  yes or no on its own, and together they define done.
  - Good: "`npm test` passes and covers the empty-list case", "`GET /todos` returns 200 with a
    JSON array", "Submitting an invalid email shows 'Please enter a valid email'".
  - Bad: "Login works correctly", "Errors are handled properly", "The code is clean".
- **Steps say how**, with file paths, function names and patterns: "Add a zod schema for the form
  in `src/forms/login.ts` and show its error under the field", not "Build the form".
- **No research, decision or "investigate" tasks.** Settle those questions with the owner now. A
  question the loop meets mid-task stops the run until a person answers.
- **Settle prerequisites now.** The loop agent cannot ask anyone for a credential, an account or
  a running service, and stops the run when it lacks one. List what the work needs (environment
  variable names, databases, third-party accounts, test users, CLIs) in the PRD under
  Prerequisites. When there are any, make the first task verify them with read-only checks, so a
  missing one stops the run on the first iteration rather than halfway through. Never write a
  secret value anywhere: name the variable and where it is set.

## Process

1. **Explore first.** Read the repository before asking anything: README, manifests
   (`package.json`, `pyproject.toml`, `go.mod`...), the directory layout, existing tests, CI config
   and the git log. Read any existing plan in `.ralph/`. Never ask what the repository answers.
2. **Ask.** Ask what you need to write a plan a stranger could implement: goals, users, scope and
   non-goals, stack and constraints, prerequisites, what done looks like. Ask at most five
   questions at a time, most important first, each with a suggested default the owner can simply
   accept. Use a tool for asking the owner directly if you have one.
3. **Stop asking** as soon as you could write the plan. Record anything still open as an
   assumption in the PRD.
4. **Write the files** below.
5. **Check them.** Run `ralph doctor` if `ralph` is installed, and fix every problem it reports
   under `plan` and `task list`. Its other checks are about the loop's environment, not the plan,
   and it stops before them if the loop's agent harness is not installed on this machine. Without
   those two lines, check by hand: every id in `tasks.json` has a spec named after it, every spec
   is listed once, every spec has a title and a non-empty `acceptanceCriteria` list.
6. **Summarise** the plan for the owner: one line per task, in run order, and the assumptions.
7. **Commit** the plan files and nothing else, once the owner is happy with it:
   `git add .ralph/prd .ralph/tasks.json .ralph/tasks` and
   `git commit -m "chore(ralph): plan <what it covers>"`. List the tasks added in the body.

## Files

Write only inside `.ralph/`. Do not change source code, install anything or run builds: planning
changes the plan, and the loop changes the code.

- `.ralph/prd/PRD.md`: the product requirements, with sections Goals, Scope, Non-goals,
  Constraints (stack, versions, conventions, services), Prerequisites, Acceptance criteria, and
  Assumptions. Keep it short: the loop reads it every iteration.
- `.ralph/tasks/TASK-N.json`: one spec per task, the only place a task is described:

  ```json
  {
    "id": "TASK-1",
    "title": "Short imperative summary",
    "category": "setup",
    "description": "What this task delivers and why, and which PRD goal it serves.",
    "steps": ["Concrete step", "Another concrete step"],
    "acceptanceCriteria": ["A checkable result", "Tests covering the new behaviour pass"],
    "notes": "Files to read first, pitfalls, constraints. Optional."
  }
  ```

  Ids are `TASK-1`, `TASK-2`, ... and the file is named after the id; the loop only recognises ids
  of that form. `category` is a free-form label such as `setup`, `functional`, `api`, `ui` or
  `docs`. A scaffolded `.ralph/tasks/TASK-1.json` that still reads "Short description of the first
  unit of work" is only an example: overwrite it.
- `.ralph/tasks.json`: the run order and status, one entry per spec and nothing else:

  ```json
  [
    { "id": "TASK-1", "passes": false },
    { "id": "TASK-2", "passes": false }
  ]
  ```

  The loop works through it top to bottom, so list each task after the tasks it builds on. Every
  spec in `.ralph/tasks/` must be listed exactly once. New tasks start with `"passes": false`.
- `.ralph/STEERING.md`: leave it alone unless something must be fixed before any feature work,
  such as a broken build or failing tests. Then list it there.

Leave `.ralph/PROMPT.md`, `.ralph/logs/` and `ralph.config.json` alone.

## Revising a plan

A plan exists when `.ralph/prd/PRD.md` and the specs are no longer the scaffold's templates. Read
it, and the log in `.ralph/logs/LOG.md`, before asking what should change.

- Keep tasks with `"passes": true` and their specs exactly as they are.
- Keep existing ids stable. Number new tasks after the highest existing id, including split tasks
  such as `TASK-8.2`.
- List each new task in `tasks.json` where it should run, which may be ahead of older unfinished
  tasks.
- To drop a task, delete its spec as well as its entry: a spec left in `.ralph/tasks/` is still a
  task.
- Do not edit a task the loop is in the middle of (it has a handoff in `.ralph/handoff/`) unless
  the owner asks: the next iteration resumes from that handoff.
