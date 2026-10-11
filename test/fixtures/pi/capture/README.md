# Captured pi sessions

The `*.jsonl` files beside this folder are real `pi --mode rpc` sessions (pi 1.1.0, `@earendil-works/pi-coding-agent`), one scenario
each, recorded as `{t, dir, line}`: `t` is milliseconds since the process started, `dir` is `in`
(a command Ralph would send) or `out` (what pi wrote on stdout), `line` is the JSON line. The fake
pi (`test/helpers/fake-pi.mjs`) replays them, and `test/pi-translate.test.ts` translates them.

The model was a scripted OpenAI-compatible stub (`stub.mjs`), not a real LLM: the protocol, the
ordering and the event JSON are pi's own, but the token counts are what the stub reported.
Absolute paths were rewritten to `/work/...`. The agent dir held only the stub's `models.json` and a
`settings.json` of `{"compaction":{"keepRecentTokens":1}}`, so that a short session has something to compact.

To record every session again (for a new pi version), with a pi installed somewhere and a scratch dir:

```sh
PI=/path/to/pi WORK=/tmp/pi-rec ./record-all.sh            # or name scenarios: ./record-all.sh gate-block retry
node summarize.mjs /tmp/pi-rec/out/gate-block.jsonl          # review, then copy /tmp/pi-rec/out/*.jsonl over ../
```

To record one session by hand:

```sh
# a pi agent dir whose models.json points at the stub (provider "stub", model "stub-model")
STUB_MODE=tool node stub.mjs &            # tool | text | slow | error | overflow | overflow-once
PI=/path/to/pi AGENT_DIR=... PROJECT_DIR=... SESSIONS_DIR=... node record.mjs out.jsonl '[{"at":2000,"cmd":{"id":"r1","type":"prompt","message":"hi"}}]'
node summarize.mjs out.jsonl              # one line per event
```

`AUTO_UI=1` makes it answer extension dialogs with `cancelled: true`; `UI_REPLY` answers each with one body,
and `UI_REPLIES` (a JSON list) answers the first dialogs with these bodies in turn. `STUB_OVERFLOW_AT` (a
comma list of call numbers) has the stub overflow on just those calls.

## What pi 1.1 changed

- `agent_settled` (`{"aborted": bool}`) ends every run, once no retry or overflow recovery follows `agent_end`.
- `message_update` carries no `partial` or `message`; `toolcall_start` names the call (`id`, `toolName`) itself.
- A call cut short by `abort` ends with `stopReason: "error"` ("This operation was aborted").
- Provider errors read `<status>: <the error object as JSON>`.
- `entry_appended` reports pi's own bookkeeping, e.g. a `context_edit` leaving a failed attempt out of the context.
- Overflow recovery compacts only what lies beyond `keepRecentTokens`: with nothing to compact it settles with the
  error and no compaction events (`overflow-nothing-to-compact`). `overflow` and `overflow-recovered` therefore open
  with a turn that builds a history; the fake pi's `skip` drops it.
- A turn begins with a `system` message.

## Other sessions

- `codemode-nested-allow` / `codemode-nested-block`: `--tools +codemode`, the gate loaded, the stub calling
  `codemode` with a script that runs `git push origin main` through `tools.bash`. The script call and then the
  nested `bash` call (id `call_1/1`) are each put to the gate; `-block` allows the first and blocks the second.
- `mcp-tool`: the stdio server in `mcp-stub.mjs` (one tool, `say`) configured in the project's `.pi/mcp.json` with
  `exposure: "direct"`, pi run with `--approve` (project trust) and the gate; the stub calls `mcp__echo__say`.
- `models` was recorded with the gate, `--approve` and a project skill (`.agents/skills/demo`), so `get_commands`
  lists an extension command and a skill for the fake pi to copy.

## The gate sessions

`gate-allow`, `gate-block`, `gate-cancelled` and `gate-write` were recorded with Ralph's own extension
(`extensions/ralph-gate.mjs`) loaded, on pi 1.1.0, with the stub scripted to call a tool
(`STUB_TOOL`, `STUB_ARGS`) and `record.mjs` answering the gate's dialog with `UI_REPLY`:

```sh
STUB_MODE=tool STUB_TOOL=bash STUB_ARGS='{"command":"echo hello"}' node stub.mjs &
PI=... AGENT_DIR=... PROJECT_DIR=... SESSIONS_DIR=... UI_REPLY='{"value":"{\"allow\":true}"}' \
  node record.mjs gate-allow.jsonl '[{"at":1500,"cmd":{"id":"r1","type":"get_commands"}},{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' \
  '["-e","/path/to/extensions/ralph-gate.mjs"]'
```

`gate-allow` answers `{"allow":true}`, `gate-block` answers `{"allow":false,"reason":"..."}`, `gate-cancelled` uses
`AUTO_UI=1`, and `gate-write` is a `write` call. The fake pi plays the continuation that matches the answer a
client gives.
