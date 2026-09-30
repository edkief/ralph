# ralph

A long-running agent loop that drives [opencode](https://opencode.ai) through its HTTP API.

Ralph picks the next unfinished task from a project's `.ralph/tasks.json`, runs one agent turn
against it, verifies what actually changed in the repository, and repeats until the backlog is
done, the agent needs a human, or progress stops.

It is built for unattended runs against self-hosted models: no TTY, no sandbox, structured
logs, and watchdogs for the ways an agent turn dies quietly.

## Install

```bash
git clone <this repo> ~/Dev/ralph
cd ~/Dev/ralph
npm install
npm run build
npm link          # optional, puts `ralph` on your PATH
```

## Getting started

Run `ralph init` in the project you want worked on and plan it with the agent:

```bash
cd /path/to/project
ralph init                        # scaffold, then plan with the agent
ralph init -m anthropic/claude-x  # plan with a different model than the loop uses
```

First it scaffolds: it creates `.ralph/` from `templates/`, writes `ralph.config.json` at the
project root and adds `.ralph/history/` to `.gitignore`. Scaffolding never overwrites a file,
so running it again is harmless.

Then, in a terminal, it starts an interview with the configured opencode agent:

1. You describe the project in a few sentences.
2. The agent reads the repository and asks what it still needs to know: goals, scope,
   stack, what done looks like. It asks a few questions at a time and suggests defaults.
3. It writes `prd/PRD.md`, `tasks.json` and one spec per task in `tasks/`, sized so each
   task fits one loop iteration.
4. Ralph checks the result: task ids the loop can recognise, a spec with acceptance criteria
   for every task, no template content left. If something is wrong, the agent is sent back
   to fix it.

End each message with an empty line, so pasted text arrives whole. Type `/done` to have the
agent stop asking and write the plan with its assumptions noted in the PRD. Ctrl-C stops.

The agent may write only inside `.ralph/`. Ralph rejects any write it is asked to approve
elsewhere, but opencode asks only about what its own permission config marks `ask`, so Ralph
also compares `git status` before and after and lists any file changed outside `.ralph/`.

Review the plan, commit `.ralph/`, then run `ralph doctor` and `ralph`.

Once a plan exists, `ralph init` leaves it alone; `ralph init --replan` revises it with the
agent, keeping completed tasks and existing ids. `ralph init --no-interview` only scaffolds,
as does any run outside a terminal. Then write the PRD, tasks and specs by hand.

Planning is a one-off that rewards a stronger model than the loop may need. Set
`plan.model` (or `RALPH_PLAN_MODEL`, or `-m` on `init`) to use one; it defaults to `model`,
then the opencode server's default.

## Usage

Run it from the project you want worked on:

```bash
ralph                       # run the loop in the current directory
ralph once                  # a single iteration
ralph doctor                # check the environment, run nothing
ralph config                # print the resolved configuration
ralph init                  # scaffold .ralph/, then plan the project with the agent

ralph -C /path/to/project -n 20 -m ollama/qwen3-coder
```

Without `npm link`, substitute `node ~/Dev/ralph/dist/cli.js`.

Start with `ralph doctor`. It reports every check it makes and runs no model, so it costs
nothing to get wrong.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every task passes |
| 1 | Iteration budget exhausted with work outstanding |
| 2 | Agent raised `BLOCKED` |
| 3 | Agent raised `DECIDE` |
| 4 | Bad configuration or failed preflight |
| 5 | Model provider or opencode server unusable |
| 6 | Stalled: iterations stopped changing anything |
| 130 | Interrupted, or stopped on request |

### Stopping a run

Press Ctrl-C once and Ralph lets the current iteration finish, pushes its commits if
`git.push` is set, and exits before starting another. Press it again to interrupt the
iteration and stop now; its work is left uncommitted in the working tree.

Without a terminal, send the same signals: `kill -INT <pid>` for the first, and
`kill -TERM <pid>` to stop now (as Kubernetes does when a pod is deleted).

## What a project must provide

Ralph expects this layout in the project it runs against. `ralph init` creates it from
`templates/`.

```
.ralph/
  PROMPT.md        # required — the instructions sent each iteration
  tasks.json       # required — the backlog; a bare array of tasks
  tasks/           # optional — per-task specs referenced by specFilePath
  prd/PRD.md       # optional — what the project is for
  STEERING.md      # optional — work to do before feature tasks
  logs/LOG.md      # optional — the agent's own running log
  handoff/         # written when a task runs out of time; commit it with the work
  history/         # written by ralph; ignore it in git
ralph.config.json  # optional
```

A task needs only an `id` and a `passes` flag; `title` and `specFilePath` are used when
present. A `{ "tasks": [...] }` wrapper is accepted in place of a bare array.

`PROMPT.md` can write `{{RALPH_DIR}}` wherever it refers to the folder; Ralph replaces it with
the resolved folder, relative to the project root, so the prompt follows `ralphDir`.

The folder is resolved in this order:

1. `ralphDir` set explicitly, by `ralph.config.json`, `RALPH_DIR` or `--ralph-dir`
2. `.ralph/`, if it exists
3. `.agent/`, if it exists, with a deprecation warning
4. `.ralph/`

### Migrating from `.agent/`

Earlier versions used `.agent/`. Such projects keep working without changes: when there is
no `.ralph/`, Ralph falls back to `.agent/` and warns on each run. To migrate:

```bash
git mv .agent .ralph
```

Then, in `.ralph/PROMPT.md`, `.ralph/tasks.json` and any task specs, replace paths that say
`.agent/` (in `PROMPT.md`, `{{RALPH_DIR}}` keeps it independent of the name), rename
`agentDir` to `ralphDir` in `ralph.config.json` if you set it, and change `.agent/history/`
to `.ralph/history/` in `.gitignore`. The `agentDir` key still works, with a warning.
`ralph init` refuses to scaffold next to an unmigrated `.agent/` folder.

The agent signals back with promise tags in its replies:

| Tag | Effect |
| --- | --- |
| `<promise>TASK-7:DONE</promise>` | Claims a task; checked against the repository |
| `<promise>COMPLETE</promise>` | Backlog finished |
| `<promise>BLOCKED:reason</promise>` | Stops the run, exit 2 |
| `<promise>DECIDE:question</promise>` | Stops the run, exit 3 |

## Configuration

Resolution order is defaults < `ralph.config.json` < `RALPH_*` environment < CLI flags.
See `templates/ralph.config.json` for a complete file.

```jsonc
{
  "model": "ollama/qwen3-coder",   // provider/model, as opencode names it
  "ralphDir": ".ralph",            // project folder; omit to detect .ralph/ (or a legacy .agent/)
  "maxIterations": 20,
  "pinTask": true,                 // name the task in the prompt instead of letting the model choose
  "timeouts": {
    "iterationMs": 2700000,        // working time for one turn, then the agent is asked to wrap up
    "inactivityMs": 300000,        // no events for this long means the agent is wedged
    "wrapUpMs": 600000             // time to hand off after either, on top of iterationMs; 0 = interrupt outright
  },
  "retries": {
    "providerRetriesPerIteration": 3,
    "iterationRetries": 1,
    "backoffMs": 15000
  },
  "stall": {
    "maxUnproductiveIterations": 3,
    "maxTimeoutsPerTask": 2        // a task that runs out of time this often stops the run
  },
  "permissions": {
    "fallback": "allow",           // unattended runs need to proceed without a human
    "deny": ["git push", "git remote"]
  },
  "git": {
    "push": "never",               // never | iteration (after each commit) | end (once, when the run finishes)
    "remote": "origin"
  },
  "server": { "url": "http://opencode:4096" }, // attach instead of spawning
  "plan": {
    "model": "anthropic/claude-x", // for the `ralph init` interview; defaults to `model`
    "maxTurns": 30,                // agent turns before the interview gives up
    "maxFixAttempts": 2            // times the agent is sent back to fix an invalid plan
  }
}
```

The template leaves `model` unset, so both the loop and the interview use the opencode
server's default until you choose one.

The env overrides worth setting from a k8s manifest: `RALPH_MODEL`, `RALPH_PLAN_MODEL`, `RALPH_DIR`, `RALPH_MAX_ITERATIONS`,
`RALPH_SERVER_URL`, `RALPH_SERVER_PASSWORD`, `RALPH_ITERATION_TIMEOUT_MS`,
`RALPH_INACTIVITY_TIMEOUT_MS`, `RALPH_WRAP_UP_TIMEOUT_MS`, `RALPH_GIT_PUSH`, `RALPH_GIT_REMOTE`, `RALPH_LOG_FORMAT=json`.

Console lines are stamped with the local time, and the banner records the start date and
time zone. Containers usually run in UTC; set `TZ` (e.g. `TZ=Europe/Paris`) to see your own.
JSON logs always carry UTC ISO timestamps.

The agent can never push: `git push` stays denied, so it cannot force-push or touch remotes.
With `git.push` set, Ralph itself runs `git push <remote> HEAD` (never forced, never
prompting for credentials). A failed push is logged and retried at the next opportunity;
it does not stop the run.

## How it works

Ralph spawns `opencode serve` (or attaches to one with `server.url`), then per iteration:

1. Reads `.ralph/tasks.json` and picks the first task with `passes: false`.
2. Builds the prompt from `.ralph/PROMPT.md`, naming that task.
3. Opens a session, subscribes to `/api/event`, and sends the prompt.
4. Consumes the SSE stream, answering permission requests from policy.
5. Snapshots git and the task list before and after, and compares.

Pinning the task matters for smaller self-hosted models: "work on TASK-7" is a far more
reliable instruction than "pick the highest-priority task with `passes: false`", which asks
the model to re-derive selection logic the loop already knows. Set `pinTask: false` to hand
that choice back to the agent.

When Ralph spawns the server it captures the generated password from the server's own stdout
banner, so credentials are never scraped from `opencode pair`.

### Why the repository is the source of truth

The agent's `<promise>TASK-7:DONE</promise>` is a claim, not evidence. An iteration counts as
progress only when something actually changed: a commit landed, a `passes` flag flipped, or
files were modified. A run whose iterations stop changing anything ends as `stalled` rather
than quietly burning the whole budget.

### Failure modes it watches for

| Watchdog | What it catches |
| --- | --- |
| `retry-storm` | Provider unreachable or rate limited. opencode retries with backoff, emitting no text and no error — the loop would otherwise hang indefinitely. |
| `inactivity` | Agent produced no events at all for `inactivityMs`. |
| `iteration-timeout` | Turn used up its working time, `iterationMs`. |

A retry storm interrupts the session server-side rather than killing a process, so opencode
can clean up, and retries the whole turn (`retries.iterationRetries`): it says nothing about
the task itself.

### Running out of time

Timeouts and inactivity are handled in two stages, so an agent that runs out of time hands
its work over instead of losing it:

1. **Soft limit.** At `iterationMs`, or after `inactivityMs` without events, Ralph sends a
   wrap-up prompt into the same session: stop, commit the work as `wip(TASK-x): …`, and write
   `.ralph/handoff/TASK-x.md` for whoever picks the task up next, under fixed headings
   (Status, Done, Working tree, Next steps, Dead ends, How to verify). The agent must not
   mark the task as passing.
   - A working agent is *steered*: the prompt reaches it at its next step and the tool it is
     running is left to finish. This needs a server whose prompt API offers
     `delivery: "steer"`; otherwise the agent is interrupted first.
   - A quiet agent is stuck in a tool, so it is always interrupted first, and told not to
     run the command that hung again.
2. **Hard limit.** The wrap-up gets `wrapUpMs` (default 10 minutes), so an iteration never
   runs longer than `iterationMs + wrapUpMs`. A wrap-up that overruns or goes quiet is
   interrupted like any timeout, and is retried.

If the agent leaves no complete handoff, Ralph writes one itself from what it saw: the commits
made, the uncommitted changes, the agent's last messages and any earlier handoff. The next
iteration on the task gets the handoff in its prompt, under "Resuming", and deletes it in the
commit that completes the task. `ralph doctor` warns about handoffs left behind.

Every prompt also states the time budget and when it ends, and asks for checkpoint commits,
so that running out of time costs little.

An iteration that wrapped up is not retried; the next one resumes from the handoff. Handoff
changes alone do not count as progress, and a task that runs out of time
`stall.maxTimeoutsPerTask` times (default 2) stops the run as stalled, since it is probably
too big for one iteration and needs splitting. Set `wrapUpMs: 0` to interrupt outright as
before; the handoff is still written.

Permission requests are answered from policy, never left waiting for a human. Deny rules beat
allow rules, so a broad allow list cannot re-enable something explicitly forbidden.

## Run artefacts

Each run writes to the project's `.ralph/history/<runId>/`:

- `iteration-NNN.events.jsonl` — every event received, for debugging
- `iterations.jsonl` — one record per iteration with outcome, usage and repository delta,
  plus the wrap-up and who wrote the handoff when it ran out of time
- `run.json` — the run summary

## Notes on the opencode API

- Health is probed with `/api/location`. `/api/status` exists only on the background service,
  not on a standalone `opencode serve`.
- Skills register asynchronously after startup: an immediate query returns an empty list.
  Preflight waits for the count to settle so the first iteration is not silently skill-less.
- Preflight asserts the operationIds the loop calls still exist in the server's live
  `/openapi.json`, so a version mismatch fails loudly instead of at runtime.
- A tool's name arrives on `session.tool.input.started` while its input arrives on
  `session.tool.called`; they are correlated by call id.

The published `@opencode-ai/sdk` lags the v2 API, so this package deliberately does not depend
on it.

## Development

```bash
npm test          # unit + integration tests against a fake opencode server
npm run typecheck
```

`test/helpers/fake-server.ts` is a stand-in for opencode's HTTP API that makes the failure
paths — retry storms, timeouts, permission policy, stalls — deterministic and fast.

`test/fixtures/session-events.jsonl` is a real captured session, scrubbed of identifying
paths. The event parser is tested against it so schema drift in opencode shows up as a test
failure rather than a silent no-op at runtime.
