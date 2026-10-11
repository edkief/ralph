import { describe, expect, it } from 'vitest';
import ralphGate, { GATE_COMMAND as EXTENSION_COMMAND, GATE_TITLE as EXTENSION_TITLE, GATE_VERSION as EXTENSION_VERSION, slim, verdict } from '../extensions/ralph-gate.mjs';
import { ConfigSchema } from '../src/config/schema.js';
import { decidePermission, restrictWrites } from '../src/loop/permissions.js';
import { gateAnswer, GATE_COMMAND, GATE_EXTENSION, GATE_TITLE, GATE_VERSION, NO_PATH, parseGateFrame, permissionEvent, permissionOf } from '../src/pi/gate.js';
import { existsSync } from 'node:fs';

const defaults = ConfigSchema.parse({ projectRoot: '/project' }).permissions;

const frame = (placeholder: unknown, overrides: Record<string, unknown> = {}) => ({
  type: 'extension_ui_request',
  id: 'u1',
  method: 'input',
  title: GATE_TITLE,
  placeholder: typeof placeholder === 'string' ? placeholder : JSON.stringify(placeholder),
  ...overrides,
});

const call = (tool: string, input: Record<string, unknown>) => ({ v: GATE_VERSION, id: 'call_1', tool, input });

describe('the two halves of the gate agree', () => {
  it('on the title, the command and the version', () => {
    expect(EXTENSION_TITLE).toBe(GATE_TITLE);
    expect(EXTENSION_COMMAND).toBe(GATE_COMMAND);
    expect(EXTENSION_VERSION).toBe(GATE_VERSION);
  });

  it('on where the extension is', () => {
    expect(existsSync(GATE_EXTENSION)).toBe(true);
  });
});

describe('parseGateFrame', () => {
  it('reads a request', () => {
    expect(parseGateFrame(frame(call('bash', { command: 'ls' })))).toEqual({ id: 'u1', call: call('bash', { command: 'ls' }) });
  });

  it('leaves other frames and other dialogs alone', () => {
    expect(parseGateFrame({ type: 'agent_start' })).toBeUndefined();
    expect(parseGateFrame(frame(call('bash', {}), { title: 'Run bash?' }))).toBeUndefined();
    expect(parseGateFrame(frame(call('bash', {}), { method: 'confirm' }))).toBeUndefined();
    expect(parseGateFrame(frame(call('bash', {}), { id: undefined }))).toBeUndefined();
  });

  it('marks a request it does not understand as malformed, so it can be blocked', () => {
    expect(parseGateFrame(frame('not json'))).toMatchObject({ id: 'u1', malformed: expect.any(String) });
    expect(parseGateFrame(frame({ v: 2, tool: 'bash' }))).toMatchObject({ malformed: expect.any(String) });
    expect(parseGateFrame(frame({ v: 1 }))).toMatchObject({ malformed: expect.any(String) });
    expect(parseGateFrame(frame(undefined as unknown as string, { placeholder: undefined }))).toMatchObject({ malformed: expect.any(String) });
  });
});

describe('permissionOf', () => {
  const of = (tool: string, input: Record<string, unknown>) => permissionOf({ v: GATE_VERSION, tool, input }, 'u1', 's1');

  it('judges a command by the command', () => {
    expect(of('bash', { command: 'git push origin main', timeout: 5 })).toEqual({ id: 'u1', session: 's1', action: 'bash', resources: ['git push origin main'] });
  });

  it('judges a file tool by its path, and a search by its pattern too', () => {
    expect(of('write', { path: '.ralph/prd/PRD.md' }).resources).toEqual(['.ralph/prd/PRD.md']);
    expect(of('read', { path: 'src/a.ts' }).resources).toEqual(['src/a.ts']);
    expect(of('grep', { pattern: 'TODO', path: 'src' }).resources).toEqual(['src', 'TODO']);
    expect(of('ls', {}).resources).toEqual(['.']);
  });

  it('gives a write with no path one that is outside every scope', () => {
    expect(of('write', {}).resources).toEqual([NO_PATH]);
    expect(of('edit', { path: '' }).resources).toEqual([NO_PATH]);
    expect(of('write', { path: 5 }).resources).toEqual([NO_PATH]);
  });

  it('puts the whole input of a tool it does not know where a rule can match it', () => {
    const request = of('run_shell', { cmd: 'git push --force' });
    expect(request.resources).toEqual(['{"cmd":"git push --force"}']);
    expect(request.message).toBe('{"cmd":"git push --force"}');
    expect(decidePermission(request, defaults)).toMatchObject({ reply: 'reject', matched: 'git push' });
  });

  it('takes the path of a tool it does not know when it has one', () => {
    const request = of('apply_patch', { file_path: 'src/a.ts', patch: '...' });
    expect(request.resources).toEqual(['src/a.ts']);
  });

  it('is the permission event the loop reads, marked as a gate', () => {
    expect(permissionEvent({ v: GATE_VERSION, tool: 'bash', input: { command: 'ls' } }, 'u1', 's1', 7)).toEqual({
      type: 'permission.asked',
      created: 7,
      gate: true,
      id: 'u1',
      session: 's1',
      action: 'bash',
      resources: ['ls'],
    });
  });
});

describe('the policy over pi tool calls', () => {
  const of = (tool: string, input: Record<string, unknown>) => permissionOf({ v: GATE_VERSION, tool, input }, 'u1', 's1');

  it('rejects git push with the rule', () => {
    expect(decidePermission(of('bash', { command: 'git push origin main' }), defaults)).toEqual({ reply: 'reject', matched: 'git push', reason: 'deny-rule' });
  });

  it('allows what no rule names', () => {
    expect(decidePermission(of('bash', { command: 'npm test' }), defaults).reply).toBe('once');
  });

  it('rejects a codemode script whose text names a denied command, before it runs', () => {
    const script = 'const r = await tools.bash({ command: "git push origin main" }); return r.output;';
    expect(decidePermission(of('codemode', { code: script }), defaults)).toMatchObject({ reply: 'reject', matched: 'git push' });
  });

  it('keeps writes inside the scope, pi tool names and others', () => {
    const scoped = restrictWrites(defaults, '/project', '.ralph');
    expect(scoped(of('write', { path: '.ralph/prd/PRD.md' })).reply).toBe('once');
    expect(scoped(of('edit', { path: '/project/.ralph/tasks.json' })).reply).toBe('once');
    expect(scoped(of('write', { path: 'src/app.ts' }))).toMatchObject({ reply: 'reject', reason: 'outside-scope', matched: 'src/app.ts' });
    expect(scoped(of('edit', { path: '../outside.txt' })).reply).toBe('reject');
    expect(scoped(of('write', { path: '.ralph/../src/app.ts' })).reply).toBe('reject');
    expect(scoped(of('write', {})).reply).toBe('reject');
    expect(scoped(of('apply_patch', { file_path: 'src/app.ts' })).reply).toBe('reject');
    expect(scoped(of('multi_edit', { file_path: '.ralph/a.md' })).reply).toBe('once');
    // Reading is not writing.
    expect(scoped(of('read', { path: 'src/app.ts' })).reply).toBe('once');
  });
});

describe('gateAnswer', () => {
  it('allows for a yes of either kind', () => {
    expect(gateAnswer('once')).toBe('{"allow":true}');
    expect(gateAnswer('always')).toBe('{"allow":true}');
  });

  it('blocks otherwise, with the reason for the agent', () => {
    const answer = JSON.parse(gateAnswer('reject', 'it matches the deny rule "git push"')) as { allow: boolean; reason: string };
    expect(answer.allow).toBe(false);
    expect(answer.reason).toContain('git push');
    expect(JSON.parse(gateAnswer('reject')).reason).toContain("Ralph's permissions");
  });
});

describe('the extension', () => {
  it('slims what it sends, never the command or the path', () => {
    expect(slim('write', { path: 'a.ts', content: 'x'.repeat(100_000) })).toEqual({ path: 'a.ts' });
    expect(slim('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] })).toEqual({ path: 'a.ts', edits: 2 });
    const command = `${'echo ok; '.repeat(5_000)}git push`;
    expect(slim('bash', { command })).toEqual({ command });
    expect(slim('bash', undefined as unknown as Record<string, unknown>)).toEqual({});
  });

  it('allows only for exactly {"allow":true}', () => {
    expect(verdict('{"allow":true}')).toBeUndefined();
    for (const answer of [undefined, null, '', 'true', 'allow', '{}', '{"allow":"true"}', '{"allow":1}', '{"allow":false}', '[true]', 'null', '{"Allow":true}'] as unknown[]) {
      expect(verdict(answer)).toMatchObject({ block: true });
    }
  });

  it('blocks with the reason Ralph gave', () => {
    expect(verdict('{"allow":false,"reason":"no pushing"}')).toEqual({ block: true, reason: 'no pushing' });
    expect(verdict('{"allow":false}')).toMatchObject({ block: true, reason: expect.stringContaining('did not allow') });
  });

  /** The extension loaded into a stand-in for pi's API, which records what it registers. */
  function load() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const commands = new Map<string, unknown>();
    ralphGate({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
      registerCommand: (name: string, options: unknown) => commands.set(name, options),
    });
    const dialogs: Array<{ title: string; placeholder: string; options: { signal?: AbortSignal; timeout?: number } }> = [];
    const ctxOf = (answer: () => unknown, signal?: AbortSignal) => ({
      signal,
      ui: {
        input: async (title: string, placeholder: string, options: { signal?: AbortSignal; timeout?: number }) => {
          dialogs.push({ title, placeholder, options });
          return answer();
        },
      },
    });
    const run = (event: unknown, ctx: unknown) => handlers.get('tool_call')!(event, ctx);
    return { handlers, commands, dialogs, ctxOf, run };
  }

  const bash = { toolName: 'bash', toolCallId: 'call_1', input: { command: 'git push' } };

  it('registers the handler and then the command that proves it loaded', () => {
    const { handlers, commands } = load();
    expect([...handlers.keys()]).toEqual(['tool_call']);
    expect([...commands.keys()]).toEqual([GATE_COMMAND]);
  });

  it('puts the call to Ralph and lets it run on a yes', async () => {
    const { run, ctxOf, dialogs } = load();
    const signal = new AbortController().signal;
    expect(await run(bash, ctxOf(() => '{"allow":true}', signal))).toBeUndefined();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.title).toBe(GATE_TITLE);
    expect(JSON.parse(dialogs[0]!.placeholder)).toEqual({ v: 1, id: 'call_1', tool: 'bash', input: { command: 'git push' } });
    expect(parseGateFrame(frame(dialogs[0]!.placeholder))).toMatchObject({ call: { tool: 'bash' } });
    expect(dialogs[0]!.options.signal).toBe(signal);
  });

  it('blocks on a no, with the reason', async () => {
    const { run, ctxOf } = load();
    expect(await run(bash, ctxOf(() => gateAnswer('reject', 'it matches the deny rule "git push"')))).toMatchObject({
      block: true,
      reason: expect.stringContaining('git push'),
    });
  });

  it('blocks when there is no answer: cancelled, timed out or aborted', async () => {
    const { run, ctxOf } = load();
    expect(await run(bash, ctxOf(() => undefined))).toMatchObject({ block: true });
  });

  it('blocks when asking fails', async () => {
    const { run, ctxOf } = load();
    const result = (await run(
      bash,
      ctxOf(() => {
        throw new Error('the dialog broke');
      }),
    )) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain('the dialog broke');
  });

  it('blocks when the context has no dialogs at all', async () => {
    const { run } = load();
    expect(await run(bash, {})).toMatchObject({ block: true });
    expect(await run({}, { ui: {} })).toMatchObject({ block: true });
  });

  it('gives the dialog the timeout Ralph set, and none when it set none', async () => {
    const { run, ctxOf, dialogs } = load();
    const before = process.env['RALPH_GATE_TIMEOUT_MS'];
    try {
      delete process.env['RALPH_GATE_TIMEOUT_MS'];
      await run(bash, ctxOf(() => '{"allow":true}'));
      process.env['RALPH_GATE_TIMEOUT_MS'] = '90000';
      await run(bash, ctxOf(() => '{"allow":true}'));
      process.env['RALPH_GATE_TIMEOUT_MS'] = 'soon';
      await run(bash, ctxOf(() => '{"allow":true}'));
    } finally {
      if (before === undefined) delete process.env['RALPH_GATE_TIMEOUT_MS'];
      else process.env['RALPH_GATE_TIMEOUT_MS'] = before;
    }
    expect(dialogs.map((dialog) => dialog.options.timeout)).toEqual([undefined, 90_000, undefined]);
  });

  it('does not send what a file tool writes', async () => {
    const { run, ctxOf, dialogs } = load();
    await run({ toolName: 'write', toolCallId: 'c2', input: { path: 'a.ts', content: 'secret' } }, ctxOf(() => '{"allow":true}'));
    expect(dialogs[0]!.placeholder).not.toContain('secret');
    expect(dialogs[0]!.placeholder).toContain('a.ts');
  });
});
