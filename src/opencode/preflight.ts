import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpencodeClient } from './client.js';
import type { Config } from '../config/schema.js';
import { TaskStore } from '../tasks/store.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Warnings do not stop the run. */
  fatal: boolean;
}

/** Operations the loop calls; a server missing any of them is a version mismatch. */
/** How long to let skills finish registering before reporting on them. */
const SKILL_WAIT_MS = 20_000;

const REQUIRED_OPERATIONS = [
  'session.create',
  'session.prompt',
  'session.interrupt',
  'session.permission.reply',
  'event.subscribe',
];

/**
 * Verify the environment before burning an iteration on it. Checks the files
 * Ralph needs, then the live server: version, required API operations, model
 * availability and skill wiring.
 */
export async function preflight(config: Config, client: OpencodeClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const agentPath = (...parts: string[]) => resolve(config.projectRoot, config.agentDir, ...parts);

  results.push(fileCheck('prompt', agentPath('PROMPT.md'), true));
  results.push(fileCheck('prd', agentPath('prd', 'PRD.md'), false));
  results.push(fileCheck('structure', agentPath('STRUCTURE.md'), false));

  const store = TaskStore.forProject(config.projectRoot, config.agentDir);
  try {
    const summary = store.reload();
    results.push({
      name: 'tasks',
      ok: true,
      detail: `${summary.passedCount}/${summary.total} passing, next ${summary.next?.id ?? 'none'}`,
      fatal: true,
    });
  } catch (cause) {
    results.push({ name: 'tasks', ok: false, detail: (cause as Error).message, fatal: true });
  }

  try {
    const location = await client.health();
    results.push({
      name: 'server',
      ok: true,
      detail: `ready at ${client.url} (${location.directory ?? 'unknown directory'})`,
      fatal: true,
    });
  } catch (cause) {
    results.push({ name: 'server', ok: false, detail: (cause as Error).message, fatal: true });
    return results;
  }

  results.push(await operationsCheck(client));
  results.push(await modelCheck(client, config));
  results.push(await skillsCheck(client));

  return results;
}

function fileCheck(name: string, path: string, fatal: boolean): CheckResult {
  const ok = existsSync(path);
  return { name, ok, detail: ok ? path : `missing: ${path}`, fatal };
}

async function operationsCheck(client: OpencodeClient): Promise<CheckResult> {
  try {
    const spec = await client.openapi();
    const available = new Set<string>();
    for (const methods of Object.values(spec.paths ?? {})) {
      for (const operation of Object.values(methods)) {
        if (operation?.operationId) available.add(operation.operationId);
      }
    }
    const missing = REQUIRED_OPERATIONS.filter((id) => !available.has(id));
    return {
      name: 'api',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${REQUIRED_OPERATIONS.length} required operations present`
          : `server is missing: ${missing.join(', ')}`,
      fatal: true,
    };
  } catch (cause) {
    return { name: 'api', ok: false, detail: (cause as Error).message, fatal: false };
  }
}

async function modelCheck(client: OpencodeClient, config: Config): Promise<CheckResult> {
  if (!config.model) {
    try {
      const fallback = await client.defaultModel();
      const id = [fallback.providerID, fallback.modelID].filter(Boolean).join('/');
      return {
        name: 'model',
        ok: Boolean(id),
        detail: id ? `using server default ${id}` : 'server has no default model',
        fatal: false,
      };
    } catch (cause) {
      return { name: 'model', ok: false, detail: (cause as Error).message, fatal: false };
    }
  }
  return { name: 'model', ok: true, detail: config.model, fatal: false };
}

/**
 * Skills register asynchronously after the server starts: querying too early
 * returns an empty list, and prompting then would quietly run the agent
 * without them. Poll briefly rather than take the first answer.
 */
async function skillsCheck(
  client: OpencodeClient,
  timeoutMs = SKILL_WAIT_MS,
): Promise<CheckResult> {
  const deadline = Date.now() + timeoutMs;
  let skills: Array<{ name: string }> = [];
  let stableReads = 0;

  for (;;) {
    let current: Array<{ name: string }>;
    try {
      current = await client.skills();
    } catch (cause) {
      return { name: 'skills', ok: false, detail: (cause as Error).message, fatal: false };
    }

    // Built-in skills appear before project ones, so a non-empty list is not
    // yet a complete list. Settle for a count that stops growing.
    stableReads = current.length === skills.length ? stableReads + 1 : 0;
    skills = current;

    if ((skills.length > 0 && stableReads >= 2) || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    name: 'skills',
    ok: skills.length > 0,
    detail:
      skills.length > 0
        ? `${skills.length} available (${skills.slice(0, 4).map((skill) => skill.name).join(', ')}…)`
        : `none registered after ${Math.round(timeoutMs / 1000)}s — the agent will run without skills`,
    fatal: false,
  };
}
