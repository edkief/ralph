---
name: ralph-grill
description: Stress-test an idea, design or Ralph plan by interviewing its owner one decision at a time, each with a recommended answer, until nothing the loop would have to guess is left open, then fold the answers into the plan. Use when asked to grill, challenge or poke holes in a plan or PRD, or before writing a Ralph plan for anything non-trivial. Not for use inside a Ralph loop iteration.
---

# Grill the plan

An agent loop cannot ask what you meant. Every decision left open in a plan becomes a guess, or a
`DECIDE` that stops the run until a person answers. Your job is to find those decisions now and
get them made.

## How

1. **Read before asking.** The repository, and the plan if there is one (`.ralph/prd/PRD.md`, the
   specs in `.ralph/tasks/`, `.ralph/tasks.json`). A question the code answers is not a question:
   answer it yourself and say so.
2. **Map the decision tree.** List the decisions the work depends on: data model, boundaries and
   interfaces, stack and libraries, error and edge cases, auth and permissions, migrations and
   existing data, performance limits, what is out of scope, how done is checked, what the work
   needs to run (credentials, services, test users). Order them so a decision comes before the
   ones that depend on it.
3. **Ask one question at a time**, walking down the tree. For each:
   - say why it matters: what the loop would build differently depending on the answer;
   - give your recommended answer and the main alternative, with the trade-off;
   - accept a short answer ("yes", "B") and move on.
   When an answer opens new branches, follow them before going back up.
4. **Push back** on answers that contradict earlier ones, the code, or the stated goals. Say what
   conflicts and ask which wins.
5. **Stop** when every decision that changes the work is made or explicitly deferred. The owner can
   also say stop at any point.

## Then

Summarise the decisions, one line each. If a plan exists, fold them in: constraints and decisions
into the PRD (Constraints, Non-goals, Assumptions), task-level detail into the specs it affects,
and new work as new tasks following the `ralph-plan` skill's rules. Never change a task with
`"passes": true`. If there is no plan yet, carry the decisions into writing one with `ralph-plan`.
