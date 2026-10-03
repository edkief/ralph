import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { handoffDir } from '../loop/handoff.js';
import { readProposal, splitDir } from '../loop/split.js';
import { changedFiles, isRepository } from '../loop/records.js';
import type { OpencodeClient, OpenApiSpec } from './client.js';
import type { Config } from '../config/schema.js';
import { TaskStore } from '../tasks/store.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Warnings do not stop the run. */
  fatal: boolean;
}

const run = promisify(execFile);

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
  const ralphPath = (...parts: string[]) => resolve(config.projectRoot, config.ralphDir, ...parts);

  results.push(fileCheck('prompt', ralphPath('PROMPT.md'), true, 'run `ralph init` to scaffold one'));
  results.push(fileCheck('prd', ralphPath('prd', 'PRD.md'), false));

  const store = TaskStore.forProject(config.projectRoot, config.ralphDir);
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

  const handoffs = handoffCheck(config);
  if (handoffs) results.push(handoffs);
  const splits = splitCheck(config);
  if (splits) results.push(splits);
  const uncommitted = await uncommittedCheck(config);
  if (uncommitted) results.push(uncommitted);
  const upstream = await upstreamCheck(config);
  if (upstream) results.push(upstream);
  const artifacts = artifactsCheck(config);
  if (artifacts) results.push(artifacts);

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

/**
 * Handoffs are how timed-out tasks resume. One for a task that already
 * passes was left behind, and would mislead anyone reading the folder.
 * Returns nothing when there are none.
 */
export function handoffCheck(config: Config): CheckResult | undefined {
  const dir = resolve(config.projectRoot, handoffDir(config.ralphDir));
  const ids = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -'.md'.length))
    : [];
  if (ids.length === 0) return undefined;

  let outstanding: Set<string>;
  try {
    const tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
    outstanding = new Set(tasks.filter((task) => !task.passes).map((task) => task.id));
  } catch {
    return undefined;
  }

  const stale = ids.filter((id) => !outstanding.has(id));
  const resuming = ids.filter((id) => outstanding.has(id));
  if (stale.length > 0) {
    return {
      name: 'handoffs',
      ok: false,
      detail: `left behind for tasks that pass or no longer exist, delete them: ${stale.join(', ')}`,
      fatal: false,
    };
  }
  return { name: 'handoffs', ok: true, detail: `resuming from a handoff: ${resuming.join(', ')}`, fatal: false };
}

/**
 * What another machine would not get from the repository: files in the Ralph
 * folder (bar its history) that are not committed. Returns nothing when there
 * are none, or outside a repository.
 */
export async function uncommittedCheck(config: Config): Promise<CheckResult | undefined> {
  if (!(await isRepository(config.projectRoot))) return undefined;
  const dir = config.ralphDir.replace(/\/+$/, '');
  const files = await changedFiles(config.projectRoot, [dir, `:(exclude)${dir}/history`]);
  if (files.length === 0) return undefined;
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
  return {
    name: 'records',
    ok: false,
    detail: `${files.length} uncommitted in ${dir}/, which another machine would not get: ${shown}. Commit them, or \`ralph stop --park\``,
    fatal: false,
  };
}

/**
 * Commits another machine would not get: the branch is ahead of its upstream
 * (as last fetched), or has none while a remote exists. Returns nothing when
 * all is pushed, or outside a repository.
 */
export async function upstreamCheck(config: Config): Promise<CheckResult | undefined> {
  const cwd = config.projectRoot;
  if (!(await isRepository(cwd))) return undefined;
  const git = async (...args: string[]) => {
    try {
      return (await run('git', args, { cwd })).stdout.trim();
    } catch {
      return undefined;
    }
  };
  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (!upstream) {
    if (!(await git('remote'))) return undefined;
    const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')) ?? 'HEAD';
    return {
      name: 'upstream',
      ok: false,
      detail: `${branch} has no upstream branch, so its commits stay on this machine: \`git push -u ${config.git.remote} ${branch}\``,
      fatal: false,
    };
  }
  const ahead = Number((await git('rev-list', '--count', `${upstream}..HEAD`)) ?? 0);
  if (ahead === 0) return undefined;
  return {
    name: 'upstream',
    ok: false,
    detail: `${ahead} commit${ahead === 1 ? '' : 's'} not pushed to ${upstream}, which another machine would not get`,
    fatal: false,
  };
}

/** Beyond this, the artifacts kept in git weigh on every clone. */
export const ARTIFACTS_WARN_BYTES = 25 * 1024 * 1024;

/**
 * The evidence agents keep in `artifacts/` is committed, so every clone
 * carries it for good. Returns nothing while it stays small.
 */
export function artifactsCheck(config: Config, limit = ARTIFACTS_WARN_BYTES): CheckResult | undefined {
  const root = resolve(config.projectRoot, config.ralphDir, 'artifacts');
  let bytes = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    }
  };
  if (existsSync(root)) visit(root);
  if (bytes <= limit) return undefined;
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return {
    name: 'artifacts',
    ok: false,
    detail: `${config.ralphDir.replace(/\/+$/, '')}/artifacts/ holds ${mb(bytes)} (over ${mb(limit)}), which every clone carries: prune it, or track it with Git LFS`,
    fatal: false,
  };
}

/**
 * A split proposed for a task still in the plan waits on a person, and the
 * loop would otherwise run the task as it is again. Returns nothing when no
 * proposal is waiting.
 */
export function splitCheck(config: Config): CheckResult | undefined {
  const root = resolve(config.projectRoot, config.ralphDir, 'split');
  if (!existsSync(root)) return undefined;

  let tasks;
  try {
    tasks = TaskStore.forProject(config.projectRoot, config.ralphDir).readTasks();
  } catch {
    return undefined;
  }
  const outstanding = new Set(tasks.filter((task) => !task.passes).map((task) => task.id));
  const waiting = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && outstanding.has(entry.name))
    .map((entry) => entry.name)
    .filter((id) => {
      const read = readProposal(config.projectRoot, config.ralphDir, id, tasks);
      return read.status !== 'missing' && !(read.status === 'ok' && (read.proposal.appliedAt || !read.proposal.splittable));
    });
  if (waiting.length === 0) return undefined;
  return {
    name: 'splits',
    ok: false,
    detail: `proposed but not applied, so the loop runs the task as it is: ${waiting
      .map((id) => `${id} (\`ralph split ${id} --apply\`, or delete ${splitDir(config.ralphDir, id)}/)`)
      .join(', ')}`,
    fatal: false,
  };
}

function fileCheck(name: string, path: string, fatal: boolean, hint?: string): CheckResult {
  const ok = existsSync(path);
  return { name, ok, detail: ok ? path : `missing: ${path}${hint ? ` — ${hint}` : ''}`, fatal };
}

export async function operationsCheck(client: OpencodeClient): Promise<CheckResult> {
  try {
    const spec = await client.openapi();
    const available = new Set<string>();
    for (const methods of Object.values(spec.paths ?? {})) {
      for (const operation of Object.values(methods)) {
        if (operation?.operationId) available.add(operation.operationId);
      }
    }
    const missing = REQUIRED_OPERATIONS.filter((id) => !available.has(id));
    const mismatch = missing.length === 0 ? replyBodyMismatch(spec) : undefined;
    if (mismatch) return { name: 'api', ok: false, detail: mismatch, fatal: true };
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

/** The field a permission decision is sent in; see `OpencodeClient.replyPermission`. */
const REPLY_FIELD = 'decision';

/**
 * An operation id says the route exists, not what it takes. A server that
 * wants the decision under another name rejects every reply, which strands
 * the agent mid-tool, so compare the body it documents with the one we send.
 * A spec that does not describe the body is given the benefit of the doubt.
 */
function replyBodyMismatch(spec: OpenApiSpec): string | undefined {
  const operation = Object.values(spec.paths ?? {})
    .flatMap((methods) => Object.values(methods))
    .find((candidate) => candidate?.operationId === 'session.permission.reply');
  const body = deref(spec, operation?.requestBody) as
    | { content?: Record<string, { schema?: unknown }>; properties?: unknown }
    | undefined;
  // The body may be the schema itself, or wrap it per content type.
  const schema = deref(spec, body?.content?.['application/json']?.schema ?? body) as
    | { properties?: Record<string, unknown> }
    | undefined;
  const fields = schema?.properties ? Object.keys(schema.properties) : [];
  if (fields.length === 0 || fields.includes(REPLY_FIELD)) return undefined;
  return `session.permission.reply does not accept "${REPLY_FIELD}" (it takes: ${fields.join(', ')}) — unsupported opencode version`;
}

/** Follow a `$ref` into the spec's shared schemas, if the value is one. */
function deref(spec: OpenApiSpec, value: unknown): unknown {
  const ref = (value as { $ref?: unknown } | undefined)?.$ref;
  if (typeof ref !== 'string') return value;
  return spec.components?.schemas?.[ref.slice(ref.lastIndexOf('/') + 1)];
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
