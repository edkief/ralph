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
