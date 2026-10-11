// Records a `pi --mode rpc` session as JSONL: every command sent (`in`) and line received (`out`),
// with milliseconds since the process started.
//
//   PI=/path/to/pi AGENT_DIR=... PROJECT_DIR=... SESSIONS_DIR=... \
//     node record.mjs out.jsonl '[{"at":2000,"cmd":{"id":"r1","type":"prompt","message":"hi"}}]' ['["-e","ext.ts"]']
//
// AGENT_DIR holds the `models.json` that points pi at stub.mjs. TOTAL (ms, default 8000) is how long
// to record before closing stdin. AUTO_UI=1 answers extension dialogs with `cancelled: true`;
// UI_REPLY='{"value":"..."}' (JSON) answers them with that body instead, e.g. what Ralph answers a gate dialog.
// UI_REPLIES='[{...},{...}]' answers the first dialogs with these bodies in turn, then falls back to UI_REPLY,
// e.g. to allow a codemode script but block the call it makes.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const [out, stepsJson, extraJson] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const extra = JSON.parse(extraJson ?? '[]');
const { PI = 'pi', AGENT_DIR, PROJECT_DIR = process.cwd(), SESSIONS_DIR, TOTAL = '8000', AUTO_UI, UI_REPLY, UI_REPLIES } = process.env;
const replies = JSON.parse(UI_REPLIES ?? '[]');
if (!AGENT_DIR || !SESSIONS_DIR) throw new Error('Set AGENT_DIR and SESSIONS_DIR');

writeFileSync(out, '');
const record = (entry) => appendFileSync(out, `${JSON.stringify({ t: Date.now() - started, ...entry })}\n`);
const started = Date.now();

const pi = spawn(PI, ['--mode', 'rpc', '--model', 'stub/stub-model', '--session-dir', SESSIONS_DIR, ...extra], {
  cwd: PROJECT_DIR,
  env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
pi.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    record({ dir: 'out', line });
    if ((AUTO_UI || UI_REPLY || replies.length > 0) && line.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(line.method)) {
      const body = replies.length > 0 ? replies.shift() : UI_REPLY ? JSON.parse(UI_REPLY) : { cancelled: true };
      const reply = { type: 'extension_ui_response', id: line.id, ...body };
      record({ dir: 'in', line: reply });
      pi.stdin.write(`${JSON.stringify(reply)}\n`);
    }
  }
});
pi.stderr.on('data', (chunk) => process.stderr.write(chunk));
pi.on('exit', () => process.exit(0));

for (const { at, cmd } of steps) {
  setTimeout(() => {
    record({ dir: 'in', line: cmd });
    pi.stdin.write(`${JSON.stringify(cmd)}\n`);
  }, at);
}
setTimeout(() => {
  pi.stdin.end();
  setTimeout(() => pi.kill('SIGTERM'), 1500);
}, Number(TOTAL));
