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
project root, adds `.ralph/history/` and `.playwright-mcp/` to `.gitignore`, and has
`.gitattributes` merge `.ralph/**/*.jsonl` as a union, so two machines appending to the same
record keep both sides' lines. Scaffolding never overwrites a file or removes a line, so
running it again is harmless.

Then, in a terminal, it starts an interview with the configured opencode agent:

1. You describe the project in a few sentences.
2. The agent reads the repository and asks what it still needs to know: goals, scope,
   stack, what done looks like. It asks a few questions at a time and suggests defaults.
   It asks in its message, not with opencode's question tool: Ralph cancels that tool's
   form and tells the agent to ask in its reply instead.
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

Without a terminal, plan from the [web UI](#web-ui) instead: start [`ralph daemon`](#daemon-mode)
in the project, even an empty one, and open the **Plan** tab. The daemon scaffolds the
project the same way, then holds the same interview there. Every interview, whether in a
terminal or from the web UI, is recorded under `.ralph/history/plans/`, so the web UI shows
it too.

`ralph init` will not plan while a daemon is up or a run is in progress in the project; plan
from the daemon's web UI then, or stop it first. Scaffolding alone is still allowed.

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
ralph --version             # print the installed version
ralph config                # print the resolved configuration
ralph init                  # scaffold .ralph/, then plan the project with the agent
ralph ui                    # serve the web UI to watch runs and browse .ralph/
ralph split TASK-8          # propose splitting a task into smaller ones
ralph split TASK-8 --apply  # replace it with the proposed tasks and commit
ralph --ui                  # run the loop and serve the web UI beside it
ralph respond               # show what Ralph is asking a person
ralph respond answer "REST" # answer it, as the web UI does
ralph daemon --detach      # stay up in the background, running batches on request
ralph daemon run -n 5       # have it run 5 iterations
ralph daemon pause          # stop its batch after the current iteration
ralph stop --park           # hand the project over: hand off, commit and push

ralph -C /path/to/project -n 20 -m ollama/qwen3-coder
```

Without `npm link`, substitute `node ~/Dev/ralph/dist/cli.js`.

Start with `ralph doctor`. It reports every check it makes and runs no model, so it costs
nothing to get wrong. It also warns about anything another machine would not get from the
repository: uncommitted files in `.ralph/` (bar its history), commits not pushed to the
upstream, a branch with no upstream, and `.ralph/artifacts/` past 25 MB.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every task passes |
| 1 | Iteration budget exhausted with work outstanding |
| 2 | Agent raised `BLOCKED` |
| 3 | Agent raised `DECIDE` |
| 4 | Bad configuration or failed preflight |
| 5 | Model provider or opencode server unusable |
| 6 | Stalled: iterations stopped changing anything, or a task kept running out of time |
| 130 | Interrupted, or stopped on request |

Codes 1, 2, 3 and 6 mean a person is needed. A run that [waits for one](#when-ralph-needs-a-person)
carries on once they answer, and exits with one of these only when told to stop. With the
[escalation agent](#the-escalation-agent) on, the run exits with one only when the agent
passes the request on.

### Web UI

A web UI shows what the loop is doing, and lets you answer it when it needs a person, at
<http://127.0.0.1:4280> by default:

- **Plan**: plan the project with the agent, through the [daemon](#daemon-mode): describe it
  (or, once there is a plan, say what should change) and start. The conversation shows as it
  happens, with the agent's current tool activity; when the agent asks, reply, **Write the
  plan now** (the terminal's `/done`) or **Stop**. The outcome follows: the tasks written, the
  problems left, or why it failed, and any file the agent changed outside `.ralph/`. Review
  `.ralph/` and commit it, as in a terminal. Without a live daemon the tab says how to plan
  instead. An interview `ralph init` holds in a terminal shows here too, to follow
- **Overview**: what the loop is doing now. What it is asking you, if anything, with the
  buttons to answer; buttons to stop the run (to pause it, under a [daemon](#daemon-mode)),
  and to have an idle daemon run a batch; the run's status, then each iteration's outcome,
  duration, tool calls, tokens and changes, with a row for every split turn, assessment or
  [escalation](#the-escalation-agent) and its outcome,
  then the task in progress, in the Tasks tab's order: the few finished just before it and the
  few that come next
- **Tasks**: the whole backlog in order, with what passes and each task's spec. A task that
  was split heads the tasks it was split into, with its title and its spec from before the
  split, and is not counted
- **Metrics**: what the project's model work came to over every run: iterations, planning
  turns and escalations, inference time, tokens (input, output, reasoning, cached), the models used, and the
  [energy drawn and estimated cost](#estimating-cost). Then the same by day (in the browser's time zone), by
  task, and by run. A task that was split keeps its title and counts the tasks it was split into,
  whether the loop split it or you did with `ralph split --apply`; open a task for
  every turn spent on it, each with its transcript
- **Transcript**: the session in progress as it happens (what the agent says, each tool call
  with its input and output, model calls, retries), or any earlier one of any run. A session
  is an iteration, the turn in which the agent assessed a task or proposed splitting it, or an
  escalation turn. A header names the session's task, by id and title, and for an iteration
  rings its time against `timeouts.iterationMs`: the ring turns amber once the agent is past it
  and wrapping up. A subagent's work is tagged as such; a turn retried in a fresh session, after
  a provider failure or a context overflow, is marked where it starts over.
  Long tool input, output and text are cut; the event file in `.ralph/history/` keeps them
  whole
- **Logs**: Ralph's own log for each run, filterable by level
- **Files**: everything in `.ralph/` (PRD, tasks, specs, steering, the agent's log, handoffs)
  and `ralph.config.json`, with Markdown rendered and images shown as pictures
- **Git**: the project's repository as it stands. The branch and how far it is ahead of or
  behind its upstream (as last fetched), the uncommitted and untracked files, and the 50 latest
  commits; pick one for its message and the files it changed, with lines added and removed.
  Ralph runs `git` in the project for this and only reads: nothing is fetched or changed

There are two ways to start it:

- `ralph ui` serves it on its own until Ctrl-C. It works entirely from the files in `.ralph/`
  (and the repository, for the Git tab), so it can watch a loop running in another terminal or
  container that shares the folder, and browse past runs after the loop has exited.
- `ralph --ui` (or `ui.enabled`, or `RALPH_UI=1`) serves it beside the loop, for as long as the
  loop runs. If it cannot start, for example because its port is taken, Ralph logs a warning
  and runs without it.

Set the address with `--ui-host`/`--ui-port`, `ui.host`/`ui.port`, or
`RALPH_UI_HOST`/`RALPH_UI_PORT`. Reading the UI needs no authentication and transcripts can
contain secrets from the repository or the environment, so it listens on `127.0.0.1` only, and
refuses requests addressed to any other host name. Binding it elsewhere logs a warning. From a
Kubernetes pod, prefer `kubectl port-forward pod/<pod> 4280` over exposing it.

Actions (answering Ralph, stopping a run, planning) are held to more than reading, because an answer
ends up in the prompt of an agent that runs shell commands:

- They are taken only when the UI listens on loopback, or when a token is set with `ui.token`
  or `RALPH_UI_TOKEN`. With a token, open the UI once as `http://host:4280/?token=<token>`:
  the browser keeps it for the session and sends it with each action. Reading stays open
  either way.
- Where access to the UI is already controlled in front of it, e.g. a reverse proxy that
  authenticates, set `ui.actions` to `"open"` (or `RALPH_UI_ACTIONS=open`) to take actions
  from other hosts without a token. Anyone who can reach the UI can then answer the agent
  and stop the run, so never do this on a port that is exposed directly. A token that is
  set is still required.
- They are taken only as JSON and only from the UI's own pages, so a page on another site
  cannot post to the UI on your machine. Behind a reverse proxy, the proxy must pass the
  original `Host` on, or set `X-Forwarded-Host`.
- Each one is logged, and recorded in the run's `actions.jsonl`.

Behind a reverse proxy that serves the UI under a path prefix, set that prefix with
`--ui-base-path`, `ui.basePath` or `RALPH_UI_BASE_PATH` (e.g. `/ralph/ws-1`). The server
strips it from every request and redirects the bare prefix to itself plus a slash; the app's
own URLs are relative, so the proxy rewrites nothing. Requests outside the prefix get 404.

#### Notifications

The web UI can notify you through your browser's Web Push service, on a desktop or a phone,
whether or not a page is open. Open **Notify me** in the header, choose what to hear about,
and **Turn on**:

- **Ralph needs me**: a request reached a person (after any [escalation agent](#the-escalation-agent)
  passed it on), or the planner asks a question in an interview held from the web UI. On by
  default.
- **A run ends**: it finished, failed, stalled or stopped. A run that ended over a request is
  told once, as the request. On by default.
- **An iteration ends**, with its outcome, and **a task passes**: off unless you tick them.

Each browser chooses for itself, and **Send a test** checks that one is reached. Clicking a
notification opens the UI on the view it is about, at the address the browser subscribed
from, so behind a reverse proxy and under `ui.basePath` it opens the proxy's address. To
open somewhere else (e.g. a public HTTPS name where you subscribed from a LAN address), set
`ui.push.url`.

- The UI server sends them, so they come only while one runs: beside the loop, in the
  [daemon](#daemon-mode), or as `ralph ui`. It checks the project every two seconds and
  tells each event once, also across restarts. A server that starts does not replay what
  happened before.
- Browsers allow Web Push only on `https://` or `localhost`/`127.0.0.1`. To get
  notifications on another device, serve the UI over HTTPS, e.g. behind a TLS proxy.
- On iPhone and iPad, Web Push reaches only a web app added to the home screen: open the UI
  in Safari, Share → Add to Home Screen, then turn notifications on from there.
- Subscribing is an action: it needs loopback, `ui.token`, or `ui.actions: "open"`, like
  answering Ralph.
- The key pair (VAPID) is made on first use and kept in `.ralph/history/push.json`, out of
  git, with the subscriptions. Deleting that file signs every browser out. Payloads are
  encrypted for each browser, so the push service (Google, Mozilla, Apple) cannot read them.
- Set `ui.push.subject` to a `mailto:` or `https:` contact for the push services. Apple
  refuses the default, `mailto:ralph@localhost`. Set `ui.push.enabled` to `false` (or
  `RALPH_UI_PUSH=0`) to turn notifications off altogether.

### When Ralph needs a person

Some things only a person can settle. Ralph leaves each as a request in `.ralph/history/pending.json`,
which the web UI shows on its Overview and `ralph respond` prints:

| What happened | What you can tell Ralph |
| --- | --- |
| A split was proposed (`stall.onRepeatedTimeout: propose`) | `approve` it; `retry` the task without splitting; `repropose` with a note saying what to change; `stop` |
| The agent raised `DECIDE` | `answer` the question; `stop` |
| The agent raised `BLOCKED` | `resume` once it is unblocked, with a note if that helps; `stop` |
| The run stalled (nothing changed, a split would not help, a command hangs) | `resume`, with a note; `stop` |
| The iteration budget is spent | `continue` for more iterations; `stop` |

By default Ralph exits at these points, with the [exit codes](#exit-codes) above. With
`--wait` (or `ui.wait`, or `RALPH_UI_WAIT=1`), which `--ui` turns on unless you pass
`--no-wait`, it waits instead: the run's status becomes `waiting`, no timeout runs, and it
carries on in the same process as soon as it is answered. `stop` ends the run as it would have
ended without waiting, with the same exit code; Ctrl-C does too.

Answer from the web UI, from the menu in the terminal the loop runs in (press Enter), or from
another terminal in the project:

```bash
ralph respond                                 # what is asked, and the answers it takes
ralph respond answer "REST, like the rest of the API"
ralph respond resume "The API key is in .env now"
ralph respond continue --iterations 5
ralph respond approve                         # same as ralph split TASK-8 --apply
```

The request and the answer are files in `.ralph/history/`, so `ralph ui` and `ralph respond` work from
another terminal or container that shares the folder. If the run has already exited, what can
be done without it still is: `approve` applies and commits the split, `answer` is kept for the
next run, `dismiss` closes the request. Then run `ralph` again.

Whatever you write (an answer, a note) is appended to `.ralph/decisions.jsonl` and the latest
20 entries are shown to the agent at the top of every later prompt, in this run and the next,
as decided. Ralph commits the file with its other [records](#carrying-on-from-another-machine),
and an answer given with no run waiting is committed straight away.

#### The escalation agent

To run end to end without a person, put a second agent between the coding agent and you. With
`escalation.enabled` (or `RALPH_ESCALATION=1`), a request goes to the escalation agent before
it reaches you. The agent runs one turn, in a session of its own, and gets:

- the request
- the task's spec and handoff
- the commits that mention the task
- the end of what the coding agent last wrote
- the decisions made so far
- the project's own guidance in `.ralph/ESCALATION.md`, which `ralph init` scaffolds

It then does one of two things:

- **Settles it.** It answers as a person could: `resume` or `answer` with a note, `approve`,
  `retry` or `repropose` a split, `continue` the budget (by at most `maxIterations` at a time).
  The run carries on. The note goes to `decisions.jsonl` marked as the escalation agent's, and
  the coding agent follows it like yours.
- **Passes it on.** The request reaches you as above, with what the agent found. The web UI and
  `ralph respond` show it. A turn that fails or times out passes the request on too.

Its prompt asks it to check the coding agent's claim, fix what it can and settle the request.
It passes on only what needs a person: credentials or access it lacks, spending money, legal or
security calls, or a product choice with nothing to go on.

It may run commands, and so fix the environment (install a dependency, start a service), but it
writes files only in the run's history and never touches the project's code. What the code
needs, it tells the coding agent in its note. It cannot `stop` the run; you can.

It runs whether or not the run waits for people, so a run without `--wait` carries on where it
would have exited. To keep it from sending the coding agent back into the same wall, it settles
at most `escalation.maxPerTask` requests per task in a run (the budget counts as one task).
After that, a request on the task comes straight to you.

```jsonc
"escalation": {
  "enabled": true,
  "kinds": ["blocked", "decide", "stalled", "split", "budget"], // which requests it gets first; all by default
  "model": "anthropic/claude-x", // defaults to plan.model, then model
  "timeoutMs": 600000,           // working time of one escalation turn
  "maxPerTask": 2                // requests it may settle per task in a run
}
```

Write in `.ralph/ESCALATION.md` what it may settle on its own and what must always come to you.
Comments in the file are left out of the prompt.

### Stopping a run

At a terminal, press Enter for a menu:

- `s` lets the current iteration finish, pushes its commits if `git.push` is set, and exits
  before starting another.
- `q` interrupts the iteration and stops now; its work is left uncommitted in the working tree.
- `h` parks the run, to [carry on elsewhere](#carrying-on-from-another-machine): the agent
  hands off at once, then its work is committed and pushed.
- When Ralph is [waiting for a person](#when-ralph-needs-a-person), the menu also takes the
  answer: approve a split or ask for another, answer a question, carry on past the budget.
- Enter or Esc closes it. Log lines wait while it is open, and it closes by itself after a
  minute.

Ctrl-C stops now, like `q`; a second one exits at once if stopping hangs.

Without a terminal, send signals to Ralph's pid: `kill -INT <pid>` to stop after the current
iteration, and `kill -TERM <pid>` to stop now (as Kubernetes does when a pod is deleted).

The opencode server Ralph starts is its child, in its process group, and stops with it. That
includes a Ralph that is killed or crashes: a small guard process notices and stops the server
within `server.shutdownTimeoutMs`, so nothing is left to clean up before the next run.

The web UI's Overview has a button for each while a run is in progress, and so does `ralph stop`
from another terminal:

```bash
ralph stop          # after the current iteration
ralph stop --now    # now, interrupting the iteration
ralph stop --park   # park: hand off, commit and push
```

Both leave a request in `.ralph/history/stop.json`, which the loop picks up within a second.
Stopping now interrupts the agent's session (and any subagents) on the opencode server, so
nothing carries on working where an opencode server outlives the run: under a
[daemon](#daemon-mode), or attached with `server.url`.

### Daemon mode

`ralph daemon` keeps Ralph up between runs. It holds the opencode server and the web UI, and
runs a batch of iterations whenever asked, from the web UI or another terminal. Pausing a
batch is stopping it, as above. However a batch ends, the daemon goes idle rather than
exiting, and waits for the next one.

```bash
ralph daemon                 # in the foreground, for systemd, nohup or a pod; idle until asked
ralph daemon --detach        # in the background; returns once it is up
ralph daemon --start -n 20   # run a first batch of 20 at once, then go idle
ralph daemon run -n 5        # have the daemon run 5 iterations (default: its -n, then maxIterations)
ralph daemon pause           # stop the batch after the current iteration, or stop an interview
ralph daemon pause --now     # stop it now, interrupting the iteration
ralph daemon pause --park    # park it: hand off, commit and push
ralph daemon status          # what the daemon and its latest run are doing
ralph daemon shutdown        # stop any batch now, and exit
```

- Each batch is a run of its own in `.ralph/history/`, with a budget of the iterations asked
  for. `ralph.config.json` is read again for each one, so changes apply from the next batch.
- A batch that spends its budget ends there rather than asking for more; run another. One
  that [needs a person](#when-ralph-needs-a-person) for anything else waits for the answer,
  as with `--ui`, unless `ui.wait` is `false`.
- The web UI is served unless you pass `--no-ui`. Its Overview shows whether the daemon is
  idle or running, has a **Run** button with the number of iterations while it is idle, and
  **Pause** buttons while a batch runs. These are actions, so they are guarded like the others.
  A batch whose preflight fails is shown there too, and the daemon stays idle.
- It also holds [planning interviews](#getting-started) asked for from the web UI's **Plan**
  tab, on its own opencode server, with `plan.model` as in a terminal. It does one thing at a
  time: while it plans, its status is `planning` and run and plan requests are refused, and
  it plans only while idle. The interview waits for your replies as long as it takes; **Stop**
  in the Plan tab, `ralph daemon pause` (with any option) or a shutdown ends it, and anything
  the agent wrote stays in `.ralph/`. An interview cut off this way, or by the daemon going
  away, ends as stopped: **Revise the plan** carries on from the files.
- `--detach` sends the daemon's output to `.ralph/history/daemon.log`.
- One daemon per project: a second one refuses to start, and so does `ralph` itself while a
  daemon is up. Steer the daemon instead.
- `ralph daemon run`, `pause`, `status` and `shutdown` work through files in
  `.ralph/history/` (`daemon.json`, `daemon-request.json`), so they, and the web UI, also work
  from another terminal or container that shares the folder.
- SIGTERM, SIGINT or SIGHUP to the daemon shuts it down like `ralph daemon shutdown`; it exits 0.

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
  ESCALATION.md    # optional — guidance for the escalation agent
  logs/LOG.md      # optional — the agent's own running log
  handoff/         # written when a task runs out of time or is parked
  split/           # proposed and applied splits of tasks that were too big, and what each split task was
  assess/          # the estimate of each task assessed before its first attempt
  decisions.jsonl  # what a person (or the escalation agent) answered or noted; shown to the agent in later prompts
  artifacts/       # evidence the agent keeps, by task: screenshots, short reports
  journal/         # what each run did, committed by ralph
  history/         # written by ralph for this machine; ignore it in git
ralph.config.json  # optional
```

A task needs only an `id` and a `passes` flag; `title` and `specFilePath` are used when
present. Ralph adds `splitFrom` and `splitDepth` to tasks it creates by splitting another. A `{ "tasks": [...] }` wrapper is accepted in place of a bare array.

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

`BLOCKED` is for problems the agent cannot fix from here, not for unfinished work. An agent that
runs out of time hands off and ends without a tag. A `BLOCKED` or `DECIDE` raised in answer to the
wrap-up is ignored, and the next iteration resumes from the handoff (see
[Running out of time](#running-out-of-time)).

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
    "iterationRetries": 1,         // retries of a turn the provider failed or that outgrew the context window
    "earlyStopResumes": 2,         // times an agent that ends its turn early is told to carry on; 0 = never
    "backoffMs": 15000
  },
  "stall": {
    "maxUnproductiveIterations": 3,
    "maxTimeoutsPerTask": 2,       // a task that runs out of time or context this often has stalled
    "onRepeatedTimeout": "propose", // then: stop | propose a split and stop | split it and carry on
    "maxSplitDepth": 1             // how often a task and its descendants may be split
  },
  "assess": {
    "mode": "off",                 // before a task's first attempt: off | propose a split if it is too big | split it
    "thresholdMs": 1800000,        // an estimate over this is too big; defaults to timeouts.iterationMs
    "timeoutMs": 300000            // working time of the triage turn that estimates the task
  },
  "escalation": {
    "enabled": false,              // an agent settles requests before they reach a person
    "kinds": ["blocked", "decide", "stalled", "split", "budget"],
    "model": "anthropic/claude-x", // defaults to plan.model, then model
    "timeoutMs": 600000,
    "maxPerTask": 2                // requests it may settle per task in a run
  },
  "permissions": {
    "fallback": "allow",           // unattended runs need to proceed without a human
    "deny": ["git push", "git remote"]
  },
  "git": {
    "push": "never",               // never | iteration (after each commit) | end (once, when the run finishes)
    "records": "end",              // when Ralph commits its records: end (of a run) | iteration | never
    "remote": "origin"
  },
  "server": { "url": "http://opencode:4096" }, // attach instead of spawning
  "plan": {
    "model": "anthropic/claude-x", // for the `ralph init` interview; defaults to `model`
    "maxTurns": 30,                // agent turns before the interview gives up
    "maxFixAttempts": 2            // times the agent is sent back to fix an invalid plan
  },
  "ui": {
    "enabled": false,              // serve the web UI beside the loop, like --ui
    "host": "127.0.0.1",           // reading needs no authentication: keep it on loopback
    "port": 4280,
    "basePath": "",                // path prefix behind a reverse proxy, e.g. /ralph/ws-1
    "wait": false,                 // wait for a person's answer instead of exiting; defaults to `enabled`
    "token": "…",                  // required for actions when the UI is not on loopback
    "actions": "guarded",          // "open": take actions off loopback without a token (behind an authenticating proxy)
    "push": {
      "enabled": true,             // Web Push notifications to the browsers that subscribe
      "subject": "mailto:you@example.com", // contact for the push services; Apple refuses the default
      "url": "https://ralph.example.com/ws-1/" // what a click opens; defaults to where the browser subscribed
    }
  }
}
```

The template leaves `model` unset, so both the loop and the interview use the opencode
server's default until you choose one.

The env overrides worth setting from a k8s manifest: `RALPH_MODEL`, `RALPH_PLAN_MODEL`, `RALPH_ESCALATION`, `RALPH_ESCALATION_MODEL`, `RALPH_DIR`, `RALPH_MAX_ITERATIONS`,
`RALPH_SERVER_URL`, `RALPH_SERVER_PASSWORD`, `RALPH_ITERATION_TIMEOUT_MS`,
`RALPH_INACTIVITY_TIMEOUT_MS`, `RALPH_WRAP_UP_TIMEOUT_MS`, `RALPH_GIT_PUSH`, `RALPH_GIT_RECORDS`, `RALPH_GIT_REMOTE`, `RALPH_LOG_FORMAT=json`,
`RALPH_UI`, `RALPH_UI_HOST`, `RALPH_UI_PORT`, `RALPH_UI_BASE_PATH`, `RALPH_UI_WAIT`, `RALPH_UI_TOKEN`, `RALPH_UI_ACTIONS`,
`RALPH_UI_PUSH`, `RALPH_UI_PUSH_SUBJECT`, `RALPH_UI_PUSH_URL`,
`RALPH_COST_WATTS`, `RALPH_COST_PRICE_PER_KWH`, `RALPH_COST_CURRENCY`.

Console lines are stamped with the local time, and the banner records the start date and
time zone. Containers usually run in UTC; set `TZ` (e.g. `TZ=Europe/Paris`) to see your own.
JSON logs always carry UTC ISO timestamps.

The agent can never push: `git push` stays denied, so it cannot force-push or touch remotes.
With `git.push` set, Ralph itself runs `git push <remote> HEAD` (never forced, never
prompting for credentials). A failed push is logged and retried at the next opportunity;
it does not stop the run.

### Estimating cost

The Metrics tab estimates what the work cost once `metrics.cost` says how. For self-hosted
models, the `power` estimator charges electricity on inference time: the time a model spent
generating, from the start of each model call to the end of its stream, less the tool runs
within it (a test suite running does not keep the GPU busy).

```jsonc
{
  "metrics": {
    "cost": {
      "estimator": "power",        // the only one for now
      "currency": "EUR",           // shown beside every estimate, not converted; defaults to USD
      "power": {
        "watts": 450,              // what the machine draws while a model generates
        "pricePerKwh": 0.32,
        "models": { "ollama/qwen3:8b": { "watts": 180 } } // a model that draws differently
      }
    }
  }
}
```

Energy = hours generating × watts / 1000, in kWh, per model; cost = energy × price per kWh.
The tab shows both side by side: the energy once `watts` is set, the cost once `pricePerKwh` is
set too (or `RALPH_COST_WATTS`, `RALPH_COST_PRICE_PER_KWH`, `RALPH_COST_CURRENCY`). Energy does
not move with the price, so it compares across tariffs and machines; leave the price out to
track energy alone. Estimates are made as the tab reads the runs, so a new price applies to
past runs too, once the UI is restarted. Where opencode reports a cost of its own (a provider
it knows the prices of), the tab shows that beside the estimate.

Runs recorded before Ralph recorded usage per model have it worked out from their event files,
where this machine still has them. Runs known only from the [journal](#carrying-on-from-another-machine)
count their tokens under an `unknown` model, with their wall-clock time standing in for
inference time; the tab says how many turns that is.

## How it works

Ralph spawns `opencode serve` (or attaches to one with `server.url`), then per iteration:

1. Reads `.ralph/tasks.json` and picks the first task with `passes: false`.
2. Builds the prompt from `.ralph/PROMPT.md`, naming that task.
3. Opens a session, subscribes to `/api/event`, and sends the prompt.
4. Consumes the SSE stream, answering permission requests from policy and cancelling forms.
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
| `inactivity` | Agent produced no events at all for `inactivityMs`. Not checked while opencode compacts the conversation, which is silent until it ends. |
| `iteration-timeout` | Turn used up its working time, `iterationMs`. |

A retry storm interrupts the session server-side rather than killing a process, so opencode
can clean up, and retries the whole turn in a fresh session within the same iteration
(`retries.iterationRetries`): it says nothing about the task itself. A turn that runs out of
time is not retried this way; the next iteration resumes from its handoff instead (see below).

### Running out of time

Timeouts and inactivity are handled in two stages, so an agent that runs out of time hands
its work over instead of losing it:

1. **Soft limit.** At `iterationMs`, or after `inactivityMs` without events, Ralph sends a
   wrap-up prompt into the same session: stop, commit the work as `wip(TASK-x): …`, and write
   `.ralph/handoff/TASK-x.md` for whoever picks the task up next, under fixed headings
   (Status, Done, Working tree, Next steps, Dead ends, How to verify). The agent must not
   mark the task as passing, and ends without a promise tag: running out of time is not being
   blocked. Ralph ignores a `BLOCKED` or `DECIDE` raised in the wrap-up, with one exception. After
   an inactivity wrap-up, a `BLOCKED` still stops the run, since a command that hung is often the
   environment problem `BLOCKED` is for.
   - A working agent is *steered*: the prompt reaches it at its next step and the tool it is
     running is left to finish. This needs a server whose prompt API offers
     `delivery: "steer"`; otherwise the agent is interrupted first.
   - A quiet agent is stuck in a tool, so it is always interrupted first, and told not to
     run the command that hung again.
2. **Hard limit.** The wrap-up gets `wrapUpMs` (default 10 minutes), so an iteration never
   runs longer than `iterationMs + wrapUpMs`. A wrap-up that overruns or goes quiet is
   interrupted, and the iteration ends as `timeout`.

If the agent leaves no complete handoff, Ralph writes one itself from what it saw: the commits
made, the uncommitted changes, the agent's last messages and any earlier handoff. The next
iteration on the task gets the handoff in its prompt, under "Resuming", and deletes it in the
commit that completes the task. `ralph doctor` warns about handoffs left behind.

Every prompt also states the time budget and when it ends, and asks for checkpoint commits,
so that running out of time costs little.

An iteration that ran out of time is not retried, whether its wrap-up finished (`wrapped-up`)
or not (`timeout`): it is recorded as it ended, and the next iteration resumes from the handoff.
So each attempt that runs out of time uses an iteration of the budget. Handoff
changes alone do not count as progress. A task that runs out of time
`stall.maxTimeoutsPerTask` times (default 2) has stalled: it is probably too big for one
iteration and needs splitting (see below). Set `wrapUpMs: 0` to interrupt outright as before;
the handoff is still written.

### Ending a turn early

Sometimes an agent starts a long job in the background, such as a test suite, then ends its
turn expecting to be woken when the job lands. Under Ralph nothing wakes it: once the turn
ends, the session is over. The prompt says so, and asks the agent to wait for long commands
before it ends its turn.

When the agent ends its turn anyway, with working time left, no promise tag and its task not
passing, Ralph sends a prompt into the same session. It tells the agent that nothing will
resume it, to wait for the jobs it started (poll their output, or run them again in the
foreground), and then to finish the task or hand off. The resumed turn keeps the session's
context and its handle on the background job, and it only gets the iteration's remaining
working time. Ralph does this up to `retries.earlyStopResumes` times per iteration
(default 2; 0 turns it off), and not with less than a minute left or once a stop or park
was requested. The iteration record counts the resumes (`result.resumes`).

If the agent still ends early after the last resume, the task gets a handoff just as when it
runs out of time: the agent's own, or one Ralph writes from what it saw, including the agent's
last messages. The next iteration then knows where things stand. An early stop is not a sign
that the task is too big, so it does not count toward `stall.maxTimeoutsPerTask`.

### Running out of context

opencode keeps a long session inside the model's context window on its own: before each model
call it summarises older turns once the request nears the limit, and after a provider rejects
a request as too long it compacts and tries once more. Configure it under `compaction` in the
opencode config, not here. It cannot help when:

- opencode does not know the model's context size, which is common for self-hosted models.
  Declare `limit.context` for the model in the opencode config.
- the provider truncates the prompt silently instead of rejecting it. Ollama does this
  whenever the conversation outgrows `num_ctx`, so set `num_ctx` to what the model supports.
- compaction is off (`compaction.auto: false`) or the summary itself fails.

When the turn still fails, the iteration ends as `context-overflow`, with the provider's
message as its error. Ralph writes the handoff from what it saw, as for running out of time,
adds advice to keep the next session lean, and retries within the same iteration
(`retries.iterationRetries`), in a fresh session that resumes from the handoff. There is no wrap-up turn, since the full session has no room left for
one. Overflows count toward `stall.maxTimeoutsPerTask` along with timeouts, so a task too big
for one context is split like one too big for the time budget.

Compaction sends no events until it is done, so the inactivity watchdog does not trip while it
runs; the iteration and wrap-up budgets still apply. Iteration records count the compactions.

### Splitting a stalled task

`stall.onRepeatedTimeout` decides what becomes of a task that stalled:

| Value | What happens |
| --- | --- |
| `stop` | The run stops as `stalled` (exit 6), leaving the split to you. |
| `propose` (default) | Ralph has the agent propose a split, then stops as `stalled` for you to review it, or [waits for you](#when-ralph-needs-a-person) to approve it. |
| `split` | Ralph has the agent propose a split, applies it, commits it and carries on. |

The proposal comes from a split turn: a session of its own, run with `plan.model` (falling back
to `model`), whose file writes are confined to `.ralph/split/TASK-8/`. It is given the task's
spec, its handoff and the commits that mention it, and either writes a spec per new task,
`TASK-8.1.json`, `TASK-8.2.json`, … covering only the work that is left, plus a
`proposal.json` listing them in order; or writes a `proposal.json` with `"splittable": false`
and the reason, when a split would not help. Ralph checks the proposal like a plan and sends it
back to the agent up to twice to fix problems.

After a stall the agent has a third answer: `"splittable": false` with `"retry": true`, when the
attempts made real progress, what is left fits in one more iteration and nothing needs a person.
Ralph then attempts the task once more as it is, from its handoff, without stopping or asking
anyone, whether `onRepeatedTimeout` is `propose` or `split`. A task gets this once per run and
it buys one attempt: if that one is cut short too, the task has stalled again, the next split
turn is not offered the answer, and one given anyway counts as advice against splitting. The web UI shows a split turn the loop runs
like an iteration: followed live in the Transcript view, and listed on the Overview with its
outcome. A turn started with `ralph split` runs outside any run and is not recorded.

Applying a split replaces the task in `tasks.json` with the new ones, in its place so they come
next, and moves their specs next to the old spec. The old spec and its handoff move into
`.ralph/split/TASK-8/`, which stays as the record of the split: `proposal.json` gains a
`parent` with the old task's title and where its spec and handoff went. The change is
committed as `chore(plan): split TASK-8 into TASK-8.1 and TASK-8.2`. Proposed specs are plain
files: edit them before applying if they need it.

The old task is gone from `tasks.json`, but not from view. Each iteration on a task it was split
into gets a "Split from TASK-8" section in its prompt. The section names the old task, gives
its spec (the whole of what it asked for) and the handoff its last attempt left, and lists the
tasks it was split into, with which ones pass. So the agent knows the full scope and what
was already done, and keeps to its own part. For a task split twice, the section follows each
split back. The Tasks tab shows the old task over the new ones. In Metrics, the old task keeps
its title and its own figures, and adds up the new tasks' figures. A split recorded before
Ralph kept the title has it read from the archived spec.

A split is not tried, and the run stops, when:

- every attempt went quiet rather than ran out of time or context: a command probably hangs,
  which smaller tasks would hit too;
- the task was already split `stall.maxSplitDepth` times (default 1), counting its ancestors;
  0 turns splitting off;
- the agent advises against it, giving its reason as the run's message; unless it advises
  attempting the task again as it is, which Ralph does once.

`ralph split TASK-8` does the same on demand: it shows the proposal in `.ralph/split/TASK-8/`,
having the agent write one first if there is none, and `--apply` applies it. It exits 0 once
proposed or applied, 4 for an unknown task or a proposal with problems, 5 when the agent could
not propose one, and 6 when it advises against splitting or, in a proposal written by the
loop, attempting the task again as it is. Delete the folder to have the agent
propose again. `ralph doctor` warns about a split proposed but not applied, since the loop
would run the task as it is.

Permission requests are answered from policy, never left waiting for a human. Deny rules beat
allow rules, so a broad allow list cannot re-enable something explicitly forbidden. If the
server will not take an answer, the agent would wait on its tool call for good, so Ralph
interrupts the session and ends the iteration as `failed`, with the server's reason in the log.
A failure that is not an outright rejection is retried once first; a request that is already
gone (answered elsewhere) is ignored.

Forms are cancelled. opencode's `question` tool and an MCP server asking for input open a form
and wait for an answer, which nobody gives during a turn, so Ralph cancels each one, in the
session or a subagent's, with a message the agent gets as the tool's error. In the loop it says
to carry on with a sensible default or, for a decision only a person can make, to emit
`DECIDE`. While planning it says to ask in the reply. The transcript shows a notice for each.
A cancel the server will not take ends the iteration as `failed`, like a permission reply.

### Assessing a task before it starts

Splitting a stalled task costs the attempts that stalled. With `assess.mode` set, Ralph asks
first: before a task's first attempt, a triage turn estimates the working time it needs, and a
task estimated over `assess.thresholdMs` (by default `timeouts.iterationMs`) is split before
any time is spent on it.

| `assess.mode` | A task estimated too big |
| --- | --- |
| `off` (default) | No task is assessed. |
| `propose` | Ralph has the agent propose a split, then stops as `stalled` for you to review it, or [waits for you](#when-ralph-needs-a-person) to `approve` it, `retry` the task as it is, or `repropose`. |
| `split` | Ralph has the agent propose a split, applies it, commits it and carries on with the first new task. |

The triage turn is a session of its own, run with `plan.model` (falling back to `model`). It is
given the task's spec and told to plan and estimate, not to implement: to read the spec and the
code it concerns, to edit nothing, to run no builds or tests, and to answer with
`<promise>ESTIMATE:minutes:why</promise>`. Three things keep it to that:

- it has `assess.timeoutMs` (5 minutes by default) and is interrupted outright when they are up;
- its file writes are confined to `.ralph/split/TASK-8/`, like a split turn's;
- Ralph compares the repository before and after, and warns in the log when a commit appeared or a
  file changed outside `.ralph/split/`, `.ralph/assess/` and `.ralph/handoff/`. The same check now covers split turns. It reports; it does not
  undo, and what the agent runs in a shell is not otherwise restricted.

Only when the estimate is over the threshold does the split turn follow, in the same session,
so what triage read is not read again. From there it is the split described above.

An assessment never costs the run its task. When the estimate fits, when the turn times out or
gives no estimate, when the agent then advises against splitting, or when the proposal cannot
be made or applied, Ralph logs why and attempts the task as it is. Assessments and the splits
that come of them do not count against `maxIterations`.

A task is assessed once: the verdict is kept in `.ralph/assess/TASK-8.json`, and later
iterations, retries and runs go by it. Delete the file to have the task assessed again. A turn
lost to a provider failure or an interrupt leaves no verdict, so it is repeated. Not assessed
at all: a task with a handoff, which an attempt has already started, and a task already split
`stall.maxSplitDepth` times, counting its ancestors. With the default depth of 1, the tasks a
split creates are therefore not assessed again.

In `propose` mode with nobody waiting, the run stops with the proposal in `.ralph/split/TASK-8/`.
Apply it with `ralph split TASK-8 --apply` before the next run, which would otherwise attempt
the task as it is; `ralph doctor` warns about it.

## Carrying on from another machine

Everything a run resumes from is in git, so work stopped on one machine carries on on
another after a `git pull`. The agent commits its work as it goes; Ralph commits the rest.

**Ralph's records** are `decisions.jsonl`, `handoff/`, `assess/`, `split/`, `journal/` and
`artifacts/` in the Ralph folder. Ralph commits them, and nothing else, as
`chore(ralph): record run <runId>`:

- once a run ends, however it ends, before the push at its end (`git.records: "end"`, the
  default);
- or after every iteration as well (`"iteration"`), so a machine that dies mid-run loses
  little. The commit comes after the iteration's checks, so it never counts as its progress;
- or never (`"never"`), as before.

The commit is pushed with the run's own commits when `git.push` is set. An answer given while
no run waits for it is committed at once. If the commit fails (a pre-commit hook says no, say),
Ralph unstages the records again, so the agent's next commit doesn't take them, and the run's
summary says why; commit them yourself.

**The journal**, `.ralph/journal/<runId>/`, is what the web UI shows of a run on any machine.
`history/` cannot travel: its event streams grow with every iteration, and its control files
(`stop.json`, `pending.json`, `daemon.json`, a `state.json` with a pid) would act on another
machine. The journal mirrors a run without them: `run.json`, `iterations.jsonl`, `splits.jsonl`,
`escalations.jsonl`, `actions.jsonl`, the log from `info` up, `state.json` without pid and host,
and a condensed transcript per iteration, split turn and escalation turn, with long text and tool output cut and each file kept
under 256 KB. The UI lists runs from both places, prefers the history where it has one, and
never shows a journal-only run as live.

**Artifacts.** The prompt template asks the agent to keep evidence worth keeping (a screenshot
of the finished screen, a short report) in `.ralph/artifacts/<task>/` and commit it with the
task; the Files tab shows the pictures. Browser tools' own scratch folders, such as
`.playwright-mcp/`, stay out of git. Keep artifacts small; past 25 MB `ralph doctor` warns, and
Git LFS is the way to keep more.

**Parking** hands a project over in one step: `ralph stop --park`, `h` in the terminal menu,
`ralph daemon pause --park`, or **Park** in the web UI.

1. In an iteration, the agent gets the wrap-up prompt at once: commit the work as
   `wip(TASK-x): …` and write the handoff. If it leaves no complete handoff, Ralph writes one,
   as when time runs out, but a park does not count towards the task's
   [stall limit](#running-out-of-time). Waiting for a person or between iterations, the run
   just stops. With `timeouts.wrapUpMs` at 0, the iteration finishes first.
2. What is still uncommitted is committed as `wip(TASK-x): parked`: changes to tracked files,
   and new files in the Ralph folder. Untracked files elsewhere (a stray `.env`, say) are left
   alone and listed in the log.
3. Ralph's records are committed and the branch is pushed, whatever `git.push` says. A failed
   push is logged; the run still ends `stopped`.

With nothing running, `ralph stop --park`, or **Park** on the web UI's Overview, commits
Ralph's records and pushes; work left uncommitted outside them stays as it is.

On the other machine: `git pull`, then `ralph`. The next attempt at the task resumes from its
handoff, with the decisions in its prompt.

## Run artefacts

Each run writes to the project's `.ralph/history/<runId>/`:

- `iteration-NNN.events.jsonl` — every event received, for debugging
- `iterations.jsonl` — one record per iteration with outcome, usage and repository delta,
  plus the wrap-up and who wrote the handoff when it ran out of time or context. `models`
  holds its usage by model (calls, tokens by kind, inference time), every attempt, wrap-up
  and subagent included
- `log.jsonl` — Ralph's log lines, at the configured level
- `splits.jsonl` — one record per split turn: the task, what cut it short, and the outcome;
  and one per assessment (`trigger: "assessment"`), with the estimate; each with its usage
  by model in `models`
- `split-TASK-x.events.jsonl` — every event of that split turn, or of the task's assessment
- `escalations.jsonl` — one record per escalation turn: the request's kind and task, whether
  it was settled (with the answer and note), passed on (with the analysis) or failed, and its
  usage by model in `models`
- `escalation-N.events.jsonl` — every event of escalation turn N
- `state.json` — where the run stands (status, iteration, task, the split or escalation turn in
  progress, what it is waiting on a person for, pid), rewritten as it goes
- `actions.jsonl` — what a person answered, from the web UI or `ralph respond`, or the
  escalation agent in their place (`by: "agent"`)
- `run.json` — the run summary, once the run ends

The web UI reads all of these, so it needs nothing else from the loop. What of them travels
in git is in the [journal](#carrying-on-from-another-machine). Beside the runs,
`history/pending.json` holds what Ralph is asking a person while it asks, and
`history/answer.json` and `history/stop.json` carry an answer or a stop request to the loop.
`history/push.json` holds the web UI's notification key pair and subscriptions, and what it
has already told them.

Planning interviews are kept apart from the runs, in `history/plans/<id>/`: `state.json`
(where the interview stands, the question asked and its number, the outcome),
`conversation.jsonl` (what the owner, the agent and Ralph said), `turn-NNN.events.jsonl`
(every event of each turn), and while it runs, `reply.json` and `stop.json` carry the owner's
reply or a stop request to it.

## Notes on the opencode API

- Health is probed with `/api/location`. `/api/status` exists only on the background service,
  not on a standalone `opencode serve`.
- Skills register asynchronously after startup: an immediate query returns an empty list.
  Preflight waits for the count to settle so the first iteration is not silently skill-less.
- Preflight asserts the operationIds the loop calls still exist in the server's live
  `/openapi.json`, so a version mismatch fails loudly instead of at runtime. It also checks
  that the permission reply takes the decision in the `decision` field, as opencode v2.0.20
  does: a server that names it differently would reject every reply.
- A tool's name arrives on `session.tool.input.started` while its input arrives on
  `session.tool.called`; they are correlated by call id.

The published `@opencode-ai/sdk` lags the v2 API, so this package deliberately does not depend
on it.

## Development

```bash
npm test          # unit + integration tests against a fake opencode server
npm run typecheck # the CLI and the web app
npm run build     # the CLI into dist/, the web app into dist/web/
```

The web app lives in `web/` (React, built with Vite). To work on it with hot reload, run
`ralph ui` against a project and `npm run dev:web`, which proxies the API to port 4280 (or to
`RALPH_UI_URL`). React and Vite are dev dependencies: the built app ships in `dist/web/`, so
installing Ralph adds no runtime packages.

`test/helpers/fake-server.ts` is a stand-in for opencode's HTTP API that makes the failure
paths — retry storms, timeouts, permission policy, stalls — deterministic and fast.

`test/fixtures/session-events.jsonl` is a real captured session, scrubbed of identifying
paths. The event parser is tested against it so schema drift in opencode shows up as a test
failure rather than a silent no-op at runtime.
