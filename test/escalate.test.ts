import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer, type ScriptedEvent } from './helpers/fake-server.js';
import { parseEscalation, projectGuidance, runEscalation } from '../src/loop/escalate.js';
import { buildEscalationPrompt } from '../src/prompt/escalate.js';
import { agentActionsFor } from '../src/human/request.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { ConfigSchema } from '../src/config/schema.js';
import { Logger } from '../src/report/logger.js';
import { TEMPLATES_DIR } from '../src/init/scaffold.js';

const logger = new Logger({ level: 'error', stream: { write: () => true } as unknown as NodeJS.WriteStream });

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const say = (text: string): ScriptedEvent[] => [
  { type: 'session.text.ended', data: { text } },
  { type: 'session.execution.succeeded' },
];

describe('agentActionsFor', () => {
  it('offers what a person could tell a waiting loop, bar stopping it', () => {
    expect(agentActionsFor('blocked')).toEqual(['resume']);
    expect(agentActionsFor('decide')).toEqual(['answer']);
    expect(agentActionsFor('split')).toEqual(['approve', 'retry', 'repropose']);
    expect(agentActionsFor('budget')).toEqual(['continue']);
  });
});

describe('parseEscalation', () => {
  it('reads a resolution and its note', () => {
    expect(parseEscalation('Fixed it.\n<promise>RESOLVE:resume:Installed libpq; run the tests again.</promise>', ['resume'], 10)).toEqual({
      status: 'resolved',
      action: 'resume',
      text: 'Installed libpq; run the tests again.',
    });
    expect(parseEscalation('<promise> resolve : approve </promise>', ['approve', 'retry'], 10)).toEqual({ status: 'resolved', action: 'approve' });
  });

  it('reads more iterations, no more than the budget', () => {
    expect(parseEscalation('<promise>RESOLVE:continue:5:tasks are passing</promise>', ['continue'], 10)).toEqual({
      status: 'resolved',
      action: 'continue',
      iterations: 5,
      text: 'tasks are passing',
    });
    expect(parseEscalation('<promise>RESOLVE:continue:50</promise>', ['continue'], 10)).toMatchObject({ iterations: 10 });
    expect(parseEscalation('<promise>RESOLVE:continue:many</promise>', ['continue'], 10)).toMatchObject({ status: 'invalid' });
  });

  it('reads an escalation', () => {
    expect(parseEscalation('<promise>ESCALATE:Needs a Stripe key; none is in the environment.</promise>', ['resume'], 10)).toEqual({
      status: 'escalated',
      analysis: 'Needs a Stripe key; none is in the environment.',
    });
  });

  it('finds no answer in a reply Ralph cannot act on', () => {
    expect(parseEscalation('I think it should resume.', ['resume'], 10)).toMatchObject({ status: 'invalid' });
    expect(parseEscalation('<promise>RESOLVE:stop:give up</promise>', ['resume'], 10)).toMatchObject({ status: 'invalid' });
    expect(parseEscalation('<promise>RESOLVE:answer</promise>', ['answer'], 10)).toMatchObject({ status: 'invalid' });
    expect(parseEscalation('<promise>ESCALATE: </promise>', ['resume'], 10)).toMatchObject({ status: 'invalid' });
    expect(
      parseEscalation('<promise>RESOLVE:resume:go</promise> <promise>ESCALATE:or not</promise>', ['resume'], 10),
    ).toMatchObject({ status: 'invalid' });
  });
});

describe('projectGuidance', () => {
  it('keeps what the project wrote, without comments', () => {
    expect(projectGuidance('# Escalation\n\n<!-- how to use this -->\n- Prefer the standard library.\n')).toBe(
      '# Escalation\n\n\n- Prefer the standard library.',
    );
  });

  it('finds nothing in the template as ralph init writes it', () => {
    const template = readFileSync(resolve(TEMPLATES_DIR, 'ESCALATION.md'), 'utf8');
    expect(projectGuidance(template)).toBe('');
  });
});

describe('buildEscalationPrompt', () => {
  const prompt = buildEscalationPrompt({
    projectRoot: '/work/app',
    kind: 'decide',
    message: 'REST or GraphQL?',
    question: 'REST or GraphQL?',
    task: { id: 'TASK-3', title: 'API', specPath: '.ralph/tasks/TASK-3.json', specText: '{ "id": "TASK-3" }' },
    agentText: 'I could go either way.',
    decisions: [{ time: '', runId: 'r', taskId: 'TASK-1', kind: 'decide', question: 'SQL or NoSQL?', answer: 'Postgres', by: 'person' }],
    guidance: { path: '.ralph/ESCALATION.md', text: 'Never pick a paid service.' },
    actions: ['answer'],
    maxIterations: 10,
    timeoutMs: 10 * 60_000,
  });

  it('favours settling over passing on', () => {
    expect(prompt).toContain('settle what you can, and pass on only what truly needs a person');
    expect(prompt).toContain('Prefer settling to passing on');
  });

  it('gives the request, the task, what the agent wrote and the decisions so far', () => {
    expect(prompt).toContain('## Escalation: the coding agent needs a decision');
    expect(prompt).toContain('> REST or GraphQL?');
    expect(prompt).toContain('{ "id": "TASK-3" }');
    expect(prompt).toContain('I could go either way.');
    expect(prompt).toContain('TASK-1: SQL or NoSQL? → Postgres');
  });

  it('includes the project guidance', () => {
    expect(prompt).toContain('### Project guidance');
    expect(prompt).toContain('Never pick a paid service.');
  });

  it('offers only the answers that fit, and keeps the agent off the code', () => {
    expect(prompt).toContain('<promise>RESOLVE:answer:note</promise>');
    expect(prompt).not.toContain('RESOLVE:resume');
    expect(prompt).toContain('<promise>ESCALATE:');
    expect(prompt).toContain("Do not change the project's code");
  });
});

describe('runEscalation', () => {
  function project(): string {
    const root = mkdtempSync(resolve(tmpdir(), 'ralph-escalate-'));
    mkdirSync(resolve(root, '.ralph'), { recursive: true });
    writeFileSync(resolve(root, '.ralph', 'tasks.json'), JSON.stringify([{ id: 'TASK-1', title: 'Parser', passes: false }]));
    writeFileSync(resolve(root, '.ralph', 'ESCALATION.md'), 'Prefer the standard library.');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
  }

  async function escalate(root: string, script: (count: number) => ScriptedEvent[]) {
    server = await startFakeServer({ script });
    return runEscalation({
      client: new OpencodeClient({ baseUrl: server.url }),
      config: ConfigSchema.parse({ projectRoot: root, escalation: { enabled: true } }),
      logger,
      runId: '20261004-120000',
      request: { kind: 'blocked', taskId: 'TASK-1', message: 'no network' },
      agentText: '<promise>BLOCKED:no network</promise>',
      decisions: [],
      signal: new AbortController().signal,
    });
  }

  it('settles the request, with the project guidance in the prompt', async () => {
    const root = project();
    const outcome = await escalate(root, () => say('<promise>RESOLVE:resume:The network is up; npm install works.</promise>'));
    expect(outcome).toEqual({ status: 'resolved', action: 'resume', text: 'The network is up; npm install works.' });
    expect(String(server?.prompts[0]?.['text'])).toContain('Prefer the standard library.');
  });

  it('sends a reply it cannot act on back once, then gives up', async () => {
    const root = project();
    const fixed = await escalate(root, (count) => say(count === 1 ? 'Looks fine to me.' : '<promise>ESCALATE:Needs a VPN.</promise>'));
    expect(fixed).toEqual({ status: 'escalated', analysis: 'Needs a VPN.' });
    expect(String(server?.prompts[1]?.['text'])).toContain('it ends with no RESOLVE or ESCALATE tag');
    await server?.close();

    const failed = await escalate(project(), () => say('Looks fine to me.'));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(server?.prompts).toHaveLength(2);
  });
});
