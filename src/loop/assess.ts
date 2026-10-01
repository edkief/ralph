import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runIteration, type IterationHooks } from './iteration.js';
import { handoffPath } from './handoff.js';
import { restrictWrites } from './permissions.js';
import { splitDir } from './split.js';
import { buildAssessPrompt } from '../prompt/assess.js';
import type { Task } from '../tasks/store.js';
import type { OpencodeClient } from '../opencode/client.js';
import type { Config } from '../config/schema.js';
import type { Logger } from '../report/logger.js';

/** `unknown` when the triage turn gave no estimate: the task is then attempted as it is. */
export type Verdict = 'fits' | 'too-big' | 'unknown';

/** What a triage turn made of a task, kept so the task is not assessed again. */
export interface Assessment {
  task: string;
  verdict: Verdict;
  /** The working time the agent estimated, when it gave an estimate. */
  estimateMinutes?: number;
  thresholdMinutes: number;
  /** The agent's reason for its estimate, or why there is none. */
  reason: string;
  assessedAt: string;
}

export interface AssessOutcome {
  assessment: Assessment;
  /** The triage session, which a split turn carries on in. */
  sessionId?: string;
  /** False when the turn never really ran (provider failure, interrupt), so the task is assessed again. */
  recorded: boolean;
}

const ESTIMATE = /<promise>\s*ESTIMATE\s*:\s*(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?)?\s*(?::([^<]*))?<\/promise>/i;

/** The estimate in the agent's reply, if it gave one. */
export function parseEstimate(text: string): { minutes: number; reason: string } | undefined {
  const match = ESTIMATE.exec(text);
  if (!match) return undefined;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return { minutes, reason: (match[2] ?? '').trim() };
}

/** Where assessments are kept; relative to the project root. */
export function assessDir(ralphDir: string): string {
  return `${ralphDir.replace(/\/+$/, '')}/assess`;
}

function assessmentPath(projectRoot: string, ralphDir: string, taskId: string): string {
  return resolve(projectRoot, assessDir(ralphDir), `${taskId}.json`);
}

/** The estimate above which a task is split. */
export function thresholdMs(config: Config): number {
  return config.assess.thresholdMs ?? config.timeouts.iterationMs;
}

/**
 * Whether `task` is to be assessed before it is attempted: assessing is on,
 * nobody assessed or started it yet, and it could still be split.
 */
export function shouldAssess(config: Config, task: Task): boolean {
  if (config.assess.mode === 'off') return false;
  if ((task.splitDepth ?? 0) >= config.stall.maxSplitDepth) return false;
  if (existsSync(assessmentPath(config.projectRoot, config.ralphDir, task.id))) return false;
  // A handoff means an attempt is under way; what is left of it is the stall's to judge.
  return !existsSync(handoffPath(config.projectRoot, config.ralphDir, task.id));
}

/**
 * Have the agent estimate `task` in a session of its own, within
 * `assess.timeoutMs` and without writing anything. The turn never fails the
 * task: with no estimate the verdict is `unknown`.
 */
export async function assessTask(args: {
  client: OpencodeClient;
  config: Config;
  logger: Logger;
  task: Task;
  signal: AbortSignal;
  hooks?: IterationHooks;
}): Promise<AssessOutcome> {
  const { client, config, logger, task, signal } = args;
  const { projectRoot, ralphDir } = config;
  const threshold = thresholdMs(config);
  const thresholdMinutes = Math.max(1, Math.round(threshold / 60_000));
  const specFile = task.specFilePath ? resolve(projectRoot, task.specFilePath) : undefined;
  const model = config.plan.model ?? config.model;

  const result = await runIteration({
    client,
    // The turn's own budget, with no wrap-up: there is nothing to hand off.
    config: {
      ...config,
      ...(model ? { model } : {}),
      timeouts: { ...config.timeouts, iterationMs: config.assess.timeoutMs, wrapUpMs: 0 },
    },
    prompt: buildAssessPrompt({
      projectRoot,
      taskId: task.id,
      title: task.title,
      ...(specFile && existsSync(specFile)
        ? { specPath: task.specFilePath!, specText: readFileSync(specFile, 'utf8') }
        : {}),
      iterationMs: config.timeouts.iterationMs,
      thresholdMs: threshold,
      timeoutMs: config.assess.timeoutMs,
    }),
    title: `ralph assess · ${task.id}`,
    // Nothing is written in triage; the split turn that may follow writes here.
    permissions: restrictWrites(config.permissions, projectRoot, splitDir(ralphDir, task.id)),
    logger,
    ...(args.hooks ? { hooks: args.hooks } : {}),
    signal,
  });

  const estimate = parseEstimate(result.text);
  const assessment: Assessment = {
    task: task.id,
    verdict: estimate ? (estimate.minutes * 60_000 > threshold ? 'too-big' : 'fits') : 'unknown',
    ...(estimate ? { estimateMinutes: estimate.minutes } : {}),
    thresholdMinutes,
    reason: estimate
      ? estimate.reason
      : (result.error ?? result.lastProviderError ?? `the triage turn ended as ${result.status} with no estimate`),
    assessedAt: new Date().toISOString(),
  };
  const recorded = estimate !== undefined || !['provider-error', 'interrupted', 'failed'].includes(result.status);
  if (recorded) {
    const file = assessmentPath(projectRoot, ralphDir, task.id);
    mkdirSync(resolve(projectRoot, assessDir(ralphDir)), { recursive: true });
    writeFileSync(file, `${JSON.stringify(assessment, null, 2)}\n`);
  }
  return { assessment, ...(result.sessionId ? { sessionId: result.sessionId } : {}), recorded };
}
