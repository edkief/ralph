# Captured pi sessions

The `*.jsonl` files beside this folder are real `pi --mode rpc` sessions (pi 0.73.1), one scenario
each, recorded as `{t, dir, line}`: `t` is milliseconds since the process started, `dir` is `in`
(a command Ralph would send) or `out` (what pi wrote on stdout), `line` is the JSON line. The fake
pi (`test/helpers/fake-pi.mjs`) replays them, and `test/pi-translate.test.ts` translates them.

The model was a scripted OpenAI-compatible stub (`stub.mjs`), not a real LLM: the protocol, the
ordering and the event JSON are pi's own, but the token counts are what the stub reported.
Absolute paths were rewritten to `/work/...` and the credentialed built-in models were dropped
from `models.jsonl`.

To record again (for a new pi version):

```sh
# a pi agent dir whose models.json points at the stub (provider "stub", model "stub-model")
STUB_MODE=tool node stub.mjs &            # tool | text | slow | error | overflow | overflow-once
PI=/path/to/pi AGENT_DIR=... PROJECT_DIR=... SESSIONS_DIR=... node record.mjs out.jsonl '[{"at":2000,"cmd":{"id":"r1","type":"prompt","message":"hi"}}]'
node summarize.mjs out.jsonl              # one line per event
```

`AUTO_UI=1` makes it answer extension dialogs with `cancelled: true`.

## The gate sessions

`gate-allow`, `gate-block`, `gate-cancelled` and `gate-write` were recorded with Ralph's own extension
(`extensions/ralph-gate.mjs`) loaded, on pi 0.73.1, with the stub scripted to call a tool
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
