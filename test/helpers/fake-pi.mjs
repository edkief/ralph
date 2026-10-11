// A scripted stand-in for `pi --mode rpc`, built from real recorded sessions (test/fixtures/pi/*.jsonl).
//
// Configured by the FAKE_PI environment variable (JSON):
//   captures   names of recorded sessions, played in order: a command that starts a segment (prompt,
//              steer, abort, compact, extension_ui_response) plays the next recorded segment for that command
//   scale      factor on the recorded delays (default 0.02: a 6 s tool run takes 120 ms)
//   log        file the fake appends what it was run with and every command it received to
//   version    what `--version` prints (default 0.73.1)
//   models     [{provider, id}] get_available_models lists (default stub/stub-model)
//   skills     names get_commands lists as skills
//   stallAfter an event type: once a segment has played an event of it, the rest of that segment is dropped
//   exitOnPrompt  exit with this code, silently, when a prompt arrives (a crashed pi)
//   exitAfter  an event type: exit with code 7 right after writing one of it (a pi that dies mid-turn)
//
// A segment is what pi wrote between one recorded command and the next, with the recorded delays.
// Commands that only read or set state (get_state, get_available_models, get_commands, set_model,
// switch_session, ...) are answered here, in the shape pi answered them in.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(process.env.FAKE_PI ?? '{}');
const argv = process.argv.slice(2);
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/pi');
const log = (entry) => cfg.log && appendFileSync(cfg.log, `${JSON.stringify(entry)}\n`);

if (argv.includes('--version')) {
  console.log(cfg.version ?? '0.73.1');
  process.exit(0);
}

const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
log({ argv, pid: process.pid, cwd: process.cwd() });

const SEGMENT_STARTERS = new Set(['prompt', 'steer', 'abort', 'compact', 'follow_up', 'extension_ui_response']);

function read(name) {
  return readFileSync(join(fixtures, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** Split a recording into the segments each command started. */
function segmentsOf(records) {
  const segments = [];
  let current;
  for (const record of records) {
    if (record.dir === 'in') {
      current = SEGMENT_STARTERS.has(record.line.type) ? { trigger: record.line.type, at: record.t, lines: [] } : undefined;
      if (current) segments.push(current);
    } else if (record.dir === 'out' && current) {
      const line = record.line;
      // Answers to commands answered here, not replayed.
      if (line.type === 'response' && line.command !== current.trigger) continue;
      current.lines.push({ after: record.t - current.at, line });
    }
  }
  return segments;
}

const segments = (cfg.captures ?? ['tool-turn']).flatMap((name) => segmentsOf(read(name)));
const templates = read('models');
const response = (command) => templates.find((r) => r.dir === 'out' && r.line.command === command)?.line;
const modelTemplate = response('get_available_models').data.models[0];
const stateTemplate = read('tool-turn').find((r) => r.dir === 'out' && r.line.command === 'get_state').line.data;
const skillTemplate = response('get_commands').data.commands[0];

const scale = cfg.scale ?? 0.02;
const sessionDir = flag('--session-dir') ?? process.cwd();
let sessionId = randomUUID();
let sessionFile = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
let model = (flag('--model') ?? '').split('/');
let streaming = false;
const timers = new Set();

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, command, success, extra = {}) => out({ ...(id !== undefined ? { id } : {}), type: 'response', command, success, ...extra });
const modelObject = (provider, id) => ({ ...modelTemplate, provider, id, name: id });
const available = () => (cfg.models ?? [{ provider: 'stub', id: 'stub-model' }]).map((m) => modelObject(m.provider, m.id));

function touchSession() {
  if (existsSync(sessionFile)) return;
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
}

function play(segment, id, command) {
  let stalled = false;
  for (const { after, line } of segment.lines) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stalled) return;
      const value = line.type === 'response' && line.command === command ? { ...line, id } : line;
      if (value.type === 'agent_start') streaming = true;
      if (value.type === 'agent_end') streaming = false;
      out(value);
      if (cfg.exitAfter && value.type === cfg.exitAfter) process.exit(7);
      if (cfg.stallAfter && value.type === cfg.stallAfter) {
        stalled = true;
        for (const pending of timers) clearTimeout(pending);
        timers.clear();
      }
    }, Math.max(0, after * scale));
    timers.add(timer);
  }
}

function handle(command) {
  const { id, type } = command;
  log({ command });

  if (type === 'prompt' && cfg.exitOnPrompt !== undefined) process.exit(cfg.exitOnPrompt);

  if (type === 'abort') for (const timer of timers) clearTimeout(timer), timers.delete(timer);

  if (SEGMENT_STARTERS.has(type)) {
    if (type === 'prompt' || type === 'steer') touchSession();
    if (type === 'prompt' && streaming) {
      if (!command.streamingBehavior) return reply(id, type, false, { error: 'Agent is already processing. Specify streamingBehavior to queue the message.' });
      // Queued behind the turn under way; pi would run it after that, which no recording covers.
      return reply(id, type, true);
    }
    const at = segments.findIndex((s) => s.trigger === type);
    if (at < 0) {
      if (type === 'extension_ui_response') return;
      return reply(id, type, false, { error: `fake pi: no recorded ${type} left` });
    }
    return play(segments.splice(at, 1)[0], id, type);
  }

  switch (type) {
    case 'get_state':
      return reply(id, type, true, {
        data: { ...stateTemplate, model: model.length > 1 ? modelObject(model[0], model.slice(1).join('/')) : null, isStreaming: streaming, sessionId, sessionFile },
      });
    case 'get_available_models':
      return reply(id, type, true, { data: { models: available() } });
    case 'get_commands':
      return reply(id, type, true, { data: { commands: (cfg.skills ?? []).map((name) => ({ ...skillTemplate, name: `skill:${name}` })) } });
    case 'set_model': {
      const found = available().find((m) => m.provider === command.provider && m.id === command.modelId);
      if (!found) return reply(id, type, false, { error: `Model not found: ${command.provider}/${command.modelId}` });
      model = [found.provider, found.id];
      return reply(id, type, true, { data: found });
    }
    case 'switch_session': {
      if (!existsSync(command.sessionPath)) return reply(id, type, false, { error: `Session file not found: ${command.sessionPath}` });
      sessionFile = command.sessionPath;
      sessionId = sessionFile.replace(/\.jsonl$/, '').split('_').pop();
      return reply(id, type, true, { data: { cancelled: false } });
    }
    case 'new_session':
      return reply(id, type, true, { data: { cancelled: false } });
    case 'set_thinking_level':
    case 'set_auto_retry':
    case 'set_auto_compaction':
    case 'abort_retry':
      return reply(id, type, true);
    default:
      return reply(id, type, false, { error: `Unknown command: ${type}` });
  }
}

// Strict LF framing, as pi's RPC mode has.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).replace(/\r$/, '');
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
