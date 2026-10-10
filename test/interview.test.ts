import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer, type ScriptedEvent } from './helpers/fake-server.js';
import { writePlan } from './helpers/plan.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { PLAN_FORM_MESSAGE, runInterview, type InterviewIO } from '../src/init/interview.js';
import { scaffold } from '../src/init/scaffold.js';
import { PlanRecorder, readConversation, readPlanState, RecordingIO } from '../src/init/record.js';
import { planWith } from '../src/init/session.js';
import { parseDecision, parseFieldInput, terminalAskRelay } from '../src/init/terminal-asks.js';
import type { AskRelay } from '../src/loop/asks.js';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { Logger } from '../src/report/logger.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as NodeJS.WritableStream });

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A scaffolded project, optionally a git repo with the scaffold committed. */
function project(git = true): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-interview-'));
  scaffold(root);
  if (git) {
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: root });
    sh('init', '-q');
    sh('config', 'user.email', 'test@example.com');
    sh('config', 'user.name', 'Test');
    sh('add', '-A');
    sh('commit', '-qm', 'scaffold');
  }
  return root;
}

function config(root: string, overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    projectRoot: root,
    retries: { backoffMs: 0, iterationRetries: 0 },
    ...overrides,
  });
}

/** Plays the user: answers in order, then quits. Records what it was shown. */
class ScriptedUser implements InterviewIO {
  readonly said: string[] = [];
  readonly notes: string[] = [];
  readonly asked: string[] = [];
  turn?: (n: number) => void;

  constructor(private readonly answers: Array<string | null>) {}

  say(text: string): void {
    this.said.push(text);
  }
  status(): void {}
  note(text: string): void {
    this.notes.push(text);
  }
  async ask(prompt: string): Promise<string | null> {
    this.asked.push(prompt);
    return this.answers.length > 0 ? this.answers.shift()! : null;
  }
}

const say = (text: string): ScriptedEvent[] => [
  { type: 'session.text.ended', data: { text } },
  { type: 'session.execution.succeeded' },
];

const DONE = 'Plan: TASK-1 setup, TASK-2 todos. <promise>PLAN:DONE</promise>';

async function interview(
  root: string,
  cfg: Config,
  user: ScriptedUser,
  scenario: Parameters<typeof startFakeServer>[0],
  replan = false,
  asks?: AskRelay,
) {
  server = await startFakeServer(scenario);
  const client = new OpencodeClient({ baseUrl: server.url });
  return runInterview({ client, config: cfg, logger, io: user, signal: new AbortController().signal, replan, ...(asks ? { asks } : {}) });
}

const promptText = (index: number) => String(server?.prompts[index]?.['text']);

describe('runInterview', () => {
  it('relays questions and answers in one session until the plan is written', async () => {
    const root = project();
    const user = new ScriptedUser(['A todo app for my team.', 'Node 22, no database.']);

    const outcome = await interview(root, config(root, { plan: { model: 'big/planner' } }), user, {
      onPrompt: (count) => (count === 2 ? writePlan(root) : undefined),
      script: (count) => (count === 1 ? say('1. Which stack? (default: Node)') : say(DONE)),
    });

    expect(outcome).toMatchObject({ status: 'planned', turns: 2, outsideChanges: [] });
    expect(outcome.status === 'planned' && outcome.tasks.map((task) => task.id)).toEqual(['TASK-1', 'TASK-2']);
    expect(server?.sessionsCreated).toBe(1);

    expect(promptText(0)).toContain('`.ralph/prd/PRD.md`');
    expect(promptText(0)).toContain('`.ralph/tasks/TASK-N.json`');
    expect(promptText(0)).not.toContain('{{RALPH_DIR}}');
    expect(promptText(0)).toContain('Writing a new plan.');
    expect(promptText(0)).toContain('A todo app for my team.');
    expect(promptText(1)).toBe('Node 22, no database.');
    expect(server?.prompts[0]?.['model']).toEqual({ providerID: 'big', modelID: 'planner' });

    expect(user.said).toEqual(['1. Which stack? (default: Node)', 'Plan: TASK-1 setup, TASK-2 todos.']);
  });

  it('cancels a question form with a message to ask in the reply, which is then relayed', async () => {
    const root = project();
    const user = new ScriptedUser(['A todo app for my team.']);

    await interview(root, config(root), user, {
      script: [
        {
          type: 'form.created',
          raw: true,
          data: { form: { id: 'frm_1', sessionID: 'ses_fake_1', title: 'Questions', metadata: { kind: 'question' } } },
        },
        ...say('1. Which stack? (default: Node)'),
      ],
    });

    expect(server?.formCancels).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', message: PLAN_FORM_MESSAGE }]);
    expect(user.said).toEqual(['1. Which stack? (default: Node)']);
  });

  it("puts a question form to the owner through the interview's IO when it can", async () => {
    const root = project();
    // The description, then the form's two fields.
    const user = new ScriptedUser(['A todo app for my team.', '2', 'y']);

    await interview(
      root,
      config(root),
      user,
      {
        script: [
          {
            type: 'form.created',
            raw: true,
            data: {
              form: {
                id: 'frm_1',
                sessionID: 'ses_fake_1',
                title: 'Stack',
                metadata: { kind: 'question' },
                fields: [
                  { key: 'stack', type: 'string', title: 'Which stack?', options: [{ value: 'deno', label: 'Deno' }, { value: 'node', label: 'Node' }] },
                  { key: 'db', type: 'boolean', title: 'A database' },
                ],
              },
            },
          },
        ],
        onFormSettled: () => {
          for (const event of say('Noted.')) server!.emit(event);
        },
      },
      false,
      terminalAskRelay(user),
    );

    expect(server?.formReplies).toEqual([{ sessionID: 'ses_fake_1', formID: 'frm_1', answer: { stack: 'node', db: true } }]);
    expect(server?.formCancels).toEqual([]);
    expect(user.asked.slice(1, 3)).toEqual(['Which stack? (number or text) (optional)', 'A database? y/n (optional)']);
    expect(user.notes[0]).toBe('The agent asks: Stack. Answer each question (/skip to decline).');
  });

  it('falls back to the loop model when no planning model is set', async () => {
    const root = project();
    await interview(root, config(root, { model: 'loop/model' }), new ScriptedUser(['An app.']), {
      script: say('What else?'),
    });
    expect(server?.prompts[0]?.['model']).toEqual({ providerID: 'loop', modelID: 'model' });
  });

  it('turns /done into an instruction to write the plan now', async () => {
    const root = project();
    const outcome = await interview(root, config(root), new ScriptedUser(['An app.', '/done']), {
      onPrompt: (count) => (count === 2 ? writePlan(root) : undefined),
      script: (count) => (count === 1 ? say('Any constraints?') : say(DONE)),
    });

    expect(outcome.status).toBe('planned');
    expect(promptText(1)).toMatch(/^Stop asking questions\. Write the plan now/);
  });

  it('shows the question inside a DECIDE tag and waits for the answer', async () => {
    const root = project();
    const user = new ScriptedUser(['An app.']);
    await interview(root, config(root), user, {
      script: say('<promise>DECIDE:REST or GraphQL?</promise>'),
    });
    expect(user.said).toEqual(['REST or GraphQL?']);
    expect(user.asked).toEqual([expect.stringMatching(/^Describe the project/), 'you']);
  });

  it('sends validation problems back to the agent until the plan passes', async () => {
    const root = project();
    const user = new ScriptedUser(['An app.']);

    const outcome = await interview(root, config(root), user, {
      onPrompt: (count) => {
        if (count === 1) writePlan(root, [{ id: 'setup' }]);
        if (count === 2) writePlan(root);
      },
      script: say(DONE),
    });

    expect(outcome).toMatchObject({ status: 'planned', turns: 2 });
    expect(promptText(1)).toContain('- task setup: id must look like TASK-1');
    expect(user.notes).toEqual([expect.stringContaining('1 problem(s)')]);
    expect(user.asked).toHaveLength(1);
  });

  it('gives up on a plan that stays invalid after the allowed fixes', async () => {
    const root = project();
    const outcome = await interview(root, config(root, { plan: { maxFixAttempts: 1 } }), new ScriptedUser(['An app.']), {
      script: say(DONE),
    });

    expect(outcome).toMatchObject({ status: 'invalid', turns: 2 });
    expect(outcome.status === 'invalid' && outcome.problems).toContain('.ralph/prd/PRD.md is still the template');
  });

  it('stops when the user quits, before or during the conversation', async () => {
    const root = project();
    expect((await interview(root, config(root), new ScriptedUser([null]), { script: [] })).status).toBe('aborted');
    expect(server?.prompts).toHaveLength(0);
    await server?.close();

    const outcome = await interview(root, config(root), new ScriptedUser(['An app.', null]), {
      script: say('Which stack?'),
    });
    expect(outcome).toMatchObject({ status: 'aborted', turns: 1 });
  });

  it('asks again rather than sending an empty description', async () => {
    const root = project();
    const user = new ScriptedUser(['  ', 'An app.']);
    await interview(root, config(root), user, { script: say('Which stack?') });
    expect(promptText(0)).toContain('An app.');
    expect(user.asked.slice(0, 2)).toEqual([expect.stringMatching(/^Describe/), expect.stringMatching(/^Describe/)]);
  });

  it('reports a provider failure', async () => {
    const root = project();
    const retry = { type: 'session.retry.scheduled', data: { attempt: 1, error: { message: 'rate limited' } } };
    const outcome = await interview(
      root,
      config(root, { retries: { providerRetriesPerIteration: 1, iterationRetries: 0, backoffMs: 0 } }),
      new ScriptedUser(['An app.']),
      { script: [retry, { ...retry, after: 50 }, { ...retry, after: 50 }] },
    );
    expect(outcome).toMatchObject({ status: 'failed', cause: 'provider' });
  });

  it('stops after the turn budget', async () => {
    const root = project();
    const outcome = await interview(
      root,
      config(root, { plan: { maxTurns: 2 } }),
      new ScriptedUser(['An app.', 'yes', 'yes']),
      { script: say('Another question?') },
    );
    expect(outcome).toMatchObject({ status: 'failed', cause: 'turns', turns: 2 });
  });

  it('rejects writes outside the Ralph folder and reports any that happen anyway', async () => {
    const root = project();
    mkdirSync(resolve(root, 'src'));
    writeFileSync(resolve(root, 'src/dirty.ts'), 'before');

    const outcome = await interview(root, config(root), new ScriptedUser(['An app.']), {
      onPrompt: () => {
        writePlan(root);
        writeFileSync(resolve(root, 'src/new.ts'), 'agent wrote this');
        writeFileSync(resolve(root, 'src/dirty.ts'), 'agent changed this');
      },
      script: [
        { type: 'session.permission.requested', data: { id: 'per_in', action: 'edit', resources: ['.ralph/tasks.json'] } },
        { type: 'session.permission.requested', data: { id: 'per_out', action: 'edit', resources: ['src/index.ts'] } },
        ...say(DONE),
      ],
    });

    expect(server?.replies).toEqual([
      { requestID: 'per_in', reply: 'once' },
      { requestID: 'per_out', reply: 'reject' },
    ]);
    expect(outcome.outsideChanges).toEqual(['src/dirty.ts', 'src/new.ts']);
  });

  it('cannot check for outside changes without git', async () => {
    const root = project(false);
    const outcome = await interview(root, config(root), new ScriptedUser(['An app.']), {
      onPrompt: () => writePlan(root),
      script: say(DONE),
    });
    expect(outcome).toMatchObject({ status: 'planned', outsideChanges: null });
  });

  it('revises an existing plan, keeping completed tasks valid', async () => {
    const root = project();
    writePlan(root, [{ id: 'TASK-1', passes: true }]);
    const user = new ScriptedUser(['Add a search task.']);

    const outcome = await interview(
      root,
      config(root),
      user,
      {
        onPrompt: () => writePlan(root, [{ id: 'TASK-1', passes: true }, { id: 'TASK-2' }]),
        script: say(DONE),
      },
      true,
    );

    expect(outcome.status).toBe('planned');
    expect(user.asked[0]).toBe('What should change in the plan?');
    expect(promptText(0)).toContain('Revising an existing plan.');
    expect(promptText(0)).toContain('Add a search task.');
  });

  it('numbers its turns and passes their events on', async () => {
    const root = project();
    const turns: number[] = [];
    const events: string[] = [];
    const user = new ScriptedUser(['An app.', 'Node.']);
    user.turn = (n) => turns.push(n);
    server = await startFakeServer({
      onPrompt: (count) => (count === 2 ? writePlan(root) : undefined),
      script: (count) => (count === 1 ? say('Which stack?') : say(DONE)),
    });
    const client = new OpencodeClient({ baseUrl: server.url });
    await runInterview({ client, config: config(root), logger, io: user, signal: new AbortController().signal, onEvent: (event) => events.push(event.type) });

    expect(turns).toEqual([1, 2]);
    expect(events.filter((type) => type === 'session.text.ended')).toHaveLength(2);
  });
});

describe('a recorded interview', () => {
  it('keeps the conversation, each turn\'s events and the outcome under history/plans/', async () => {
    const root = project();
    const recorder = new PlanRecorder(resolve(root, '.ralph'), { mode: 'new', by: 'cli' });
    const io = new RecordingIO(new ScriptedUser(['An app.', '/done']), recorder);
    server = await startFakeServer({
      onPrompt: (count) => (count === 2 ? writePlan(root) : undefined),
      script: (count) => (count === 1 ? say('Which stack?') : say(DONE)),
    });
    const client = new OpencodeClient({ baseUrl: server.url });
    const outcome = await planWith({ client, config: config(root, { model: 'm/x' }), logger, io, signal: new AbortController().signal, replan: false });
    expect(outcome.status).toBe('planned');

    const ralphRoot = resolve(root, '.ralph');
    expect(readConversation(ralphRoot, recorder.id).map(({ role, text }) => [role, text])).toEqual([
      ['owner', 'An app.'],
      ['agent', 'Which stack?'],
      ['owner', '/done'],
      ['agent', 'Plan: TASK-1 setup, TASK-2 todos.'],
    ]);
    expect(readPlanState(ralphRoot, recorder.id)).toMatchObject({
      status: 'planned',
      by: 'cli',
      seq: 2,
      turn: 2,
      model: 'm/x',
      prompt: null,
      outcome: { tasks: [{ id: 'TASK-1' }, { id: 'TASK-2' }], outsideChanges: [] },
    });
    const events = readFileSync(resolve(recorder.dir, 'turn-001.events.jsonl'), 'utf8');
    expect(events).toContain('session.text.ended');
    expect(existsSync(resolve(recorder.dir, 'turn-002.events.jsonl'))).toBe(true);
  });
});

describe('terminal asks', () => {
  it('reads what was typed for each kind of field', () => {
    const options = [{ value: 'pg', label: 'Postgres' }, { value: 'sqlite', label: 'SQLite' }];
    expect(parseFieldInput({ key: 'a', type: 'string', options }, '2')).toEqual({ value: 'sqlite' });
    expect(parseFieldInput({ key: 'a', type: 'string', options }, 'postgres')).toEqual({ value: 'pg' });
    expect(parseFieldInput({ key: 'a', type: 'string', options }, 'mysql')).toEqual({ error: 'Pick 1 to 2' });
    expect(parseFieldInput({ key: 'a', type: 'string', options, custom: true }, 'mysql')).toEqual({ value: 'mysql' });
    expect(parseFieldInput({ key: 'a', type: 'string', default: 'x' }, ' ')).toEqual({ value: 'x' });
    expect(parseFieldInput({ key: 'n', type: 'integer' }, '2.5')).toEqual({ error: 'A whole number, please' });
    expect(parseFieldInput({ key: 'n', type: 'number' }, '2.5')).toEqual({ value: 2.5 });
    expect(parseFieldInput({ key: 'b', type: 'boolean' }, 'No')).toEqual({ value: false });
    expect(parseFieldInput({ key: 'm', type: 'multiselect', options }, '1, sqlite, 1')).toEqual({ value: ['pg', 'sqlite'] });
    expect(parseDecision('A')).toBe('always');
    expect(parseDecision('maybe')).toBeUndefined();
  });

  it('declines a form on /skip, and asks a permission until it gets an answer', async () => {
    const user = new ScriptedUser(['/skip', 'perhaps', 'o']);
    const relay = terminalAskRelay(user);
    const signal = new AbortController().signal;

    const form = await relay.form({ id: 'frm_1', sessionID: 's', title: 'Q', fields: [{ key: 'a', type: 'string' }] }, signal);
    expect(form).toEqual({ cancel: expect.stringContaining('declined') });
    const decision = await relay.permission({ id: 'per_1', sessionID: 's', action: 'shell', resources: ['make deploy'] }, signal);
    expect(decision).toBe('once');
    expect(user.notes).toContain('The agent asks to shell: make deploy');
  });
});
