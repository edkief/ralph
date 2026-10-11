#!/usr/bin/env bash
# Re-records every session in test/fixtures/pi/ against a real pi, with stub.mjs as the model.
#
#   PI=/path/to/pi WORK=/tmp/pi-rec test/fixtures/pi/capture/record-all.sh [scenario...]
#
# WORK gets an agent dir (the stub's models.json, and keepRecentTokens 1 so a short session has something to
# compact), a project and a sessions dir per scenario, and the recordings in WORK/out/, with absolute paths
# rewritten to /work/... . Review them with summarize.mjs, then copy them over test/fixtures/pi/.
set -u
C=$(cd "$(dirname "$0")" && pwd); GATE=$(cd "$C/../../../../extensions" && pwd)/ralph-gate.mjs
S=${WORK:?set WORK to a scratch directory}; PI=${PI:-pi}
mkdir -p $S/agent $S/out
echo '{"providers":{"stub":{"baseUrl":"http://127.0.0.1:18080/v1","api":"openai-completions","apiKey":"x","models":[{"id":"stub-model"}]}}}' > $S/agent/models.json
echo '{"compaction":{"keepRecentTokens":1}}' > $S/agent/settings.json
# What Ralph answers a gate request it blocks.
BLOCK='{"value":"{\"allow\":false,\"reason\":\"Ralph'"'"'s permissions do not allow this: it matches the deny rule \\\"git push\\\". Do not try another way round it; carry on without it.\"}"}'
ALLOW='{"value":"{\"allow\":true}"}'
rec() { # name mode stub_tool stub_args total steps extra [env...]
  local name=$1 mode=$2 tool=$3 args=$4 total=$5 steps=$6 extra=$7; shift 7
  rm -rf $S/proj-$name $S/sessions-$name; mkdir -p $S/proj-$name $S/sessions-$name
  [ -n "${SETUP:-}" ] && eval "$SETUP"
  local stubenv=(PORT=18080 STUB_MODE="$mode"); case $name in overflow) stubenv+=(STUB_OVERFLOW_AT=2,3,4,5,6);; overflow-recovered) stubenv+=(STUB_OVERFLOW_AT=2);; esac; [ -n "$tool" ] && stubenv+=(STUB_TOOL="$tool"); [ -n "$args" ] && stubenv+=(STUB_ARGS="$args")
  env "${stubenv[@]}" node $C/stub.mjs 2>/dev/null & local sp=$!; sleep 0.5
  env "$@" PI=$PI AGENT_DIR=$S/agent PROJECT_DIR=$S/proj-$name SESSIONS_DIR=$S/sessions-$name TOTAL=$total node $C/record.mjs $S/out/$name.jsonl "$steps" "$extra" 2>$S/out/$name.err
  kill $sp 2>/dev/null; wait $sp 2>/dev/null
  sed -i -e "s#$S/sessions-$name#/work/sessions#g" -e "s#$S/proj-$name#/work/project#g" -e "s#$S/agent#/work/agent#g" $S/out/$name.jsonl
  echo "$name: $(wc -l < $S/out/$name.jsonl) lines"
}
want() { [ $# -eq 0 ] || [[ " $* " == *" $1 "* ]]; }
G='["-e","'$GATE'"]'
B='{"command":"echo hello"}'
all="$*"
w() { [ -z "$all" ] || [[ " $all " == *" $1 "* ]]; }
w tool-turn && rec tool-turn tool '' '' 6000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"Run echo hello then finish."}}]' '[]' X=1
w abort && rec abort slow '' '' 7000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"Run the slow thing."}},{"at":3500,"cmd":{"id":"r3","type":"abort"}}]' '[]' X=1
w steer && rec steer slow '' '' 14000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"Run the slow thing."}},{"at":3500,"cmd":{"id":"r3","type":"steer","message":"Wrap up now."}}]' '[]' X=1
w compact && rec compact text '' '' 7000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"first"}},{"at":3500,"cmd":{"id":"r3","type":"compact"}}]' '[]' X=1
w retry && rec retry error '' '' 26000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"hi"}}]' '[]' X=1
# The overflow scenarios build a history first: pi 1.1 compacts only what lies beyond keepRecentTokens (set to 1
# in the agent's settings.json), and with nothing to compact it gives up without compaction events.
w overflow && rec overflow text '' '' 9000 '[{"at":1500,"cmd":{"id":"r1","type":"prompt","message":"first"}},{"at":3000,"cmd":{"id":"r2","type":"get_state"}},{"at":3500,"cmd":{"id":"r3","type":"prompt","message":"hi"}}]' '[]' STUB_OVERFLOW_AT_PASS=1
w overflow-recovered && rec overflow-recovered text '' '' 9000 '[{"at":1500,"cmd":{"id":"r1","type":"prompt","message":"first"}},{"at":3000,"cmd":{"id":"r2","type":"get_state"}},{"at":3500,"cmd":{"id":"r3","type":"prompt","message":"hi"}}]' '[]' X=1
w overflow-nothing-to-compact && { mv $S/agent/settings.json $S/agent/settings.off; rec overflow-nothing-to-compact overflow-once '' '' 6000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"hi"}}]' '[]' X=1; mv $S/agent/settings.off $S/agent/settings.json; }
w models && SETUP='mkdir -p $S/proj-$name/.agents/skills/demo && printf -- "---\\nname: demo\\ndescription: A demo skill.\\n---\\nDo the demo.\\n" > $S/proj-$name/.agents/skills/demo/SKILL.md' rec models text '' '' 5000 '[{"at":1500,"cmd":{"id":"r1","type":"get_available_models"}},{"at":1800,"cmd":{"id":"r2","type":"get_commands"}},{"at":2100,"cmd":{"id":"r3","type":"set_model","provider":"stub","modelId":"stub-model"}},{"at":2400,"cmd":{"id":"r4","type":"set_model","provider":"stub","modelId":"nope"}},{"at":2700,"cmd":{"id":"r5","type":"prompt","message":"x","streamingBehavior":"followUp"}}]' '["-e","'$GATE'","--approve"]' UI_REPLY="$ALLOW"
w extension-dialog && rec extension-dialog tool '' '' 6000 '[{"at":1500,"cmd":{"id":"r1","type":"get_state"}},{"at":2000,"cmd":{"id":"r2","type":"prompt","message":"run it"}}]' '["-e","'$C'/ext-confirm.ts"]' AUTO_UI=1
w gate-allow && rec gate-allow tool bash "$B" 7000 '[{"at":1500,"cmd":{"id":"r1","type":"get_commands"}},{"at":2000,"cmd":{"id":"r2","type":"get_state"}},{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$G" UI_REPLY="$ALLOW"
w gate-block && rec gate-block tool bash "$B" 7000 '[{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$G" UI_REPLY="$BLOCK"
w gate-cancelled && rec gate-cancelled tool bash "$B" 7000 '[{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$G" AUTO_UI=1
w gate-write && rec gate-write tool write '{"path":"src/app.ts","content":"export const app = 1;\n"}' 7000 '[{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$G" UI_REPLY="$ALLOW"
CM='{"code":"const r = await tools.bash({command:\"git push origin main\"}); return r.output;"}'
GC='["-e","'$GATE'","--tools","+codemode"]'
w codemode-nested-allow && rec codemode-nested-allow tool codemode "$CM" 7000 '[{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$GC" UI_REPLY="$ALLOW"
w codemode-nested-block && rec codemode-nested-block tool codemode "$CM" 7000 '[{"at":2500,"cmd":{"id":"r3","type":"prompt","message":"run it"}}]' "$GC" UI_REPLIES="[$ALLOW,$BLOCK]"
w mcp-tool && SETUP='mkdir -p $S/proj-$name/.pi && echo "{\"mcpServers\":{\"echo\":{\"command\":\"node\",\"args\":[\"'$C'/mcp-stub.mjs\"],\"exposure\":\"direct\"}}}" > $S/proj-$name/.pi/mcp.json' rec mcp-tool tool mcp__echo__say '{"text":"hello"}' 8000 '[{"at":2000,"cmd":{"id":"r1","type":"get_commands"}},{"at":3000,"cmd":{"id":"r3","type":"prompt","message":"say it"}}]' '["-e","'$GATE'","--approve"]' UI_REPLY="$ALLOW"
exit 0
