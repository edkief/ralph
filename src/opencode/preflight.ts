import type { OpencodeClient, OpenApiSpec } from './client.js';
import type { Config } from '../config/schema.js';
import type { CheckResult } from '../harness/types.js';

/** How long to let skills finish registering before reporting on them. */
const SKILL_WAIT_MS = 20_000;

/** Operations the loop calls; a server missing any of them is a version mismatch. */
const REQUIRED_OPERATIONS = [
  'session.create',
  'session.prompt',
  'session.interrupt',
  'session.permission.reply',
  'event.subscribe',
];

/**
 * The checks on the live opencode server: it answers, speaks the API
 * operations the loop calls, has a model, and has registered its skills.
 */
export async function harnessChecks(client: OpencodeClient, config: Config): Promise<CheckResult[]> {
  let location;
  try {
    location = await client.health();
  } catch (cause) {
    return [{ name: 'server', ok: false, detail: (cause as Error).message, fatal: true }];
  }
  return [
    {
      name: 'server',
      ok: true,
      detail: `ready at ${client.url} (${location.directory ?? 'unknown directory'})`,
      fatal: true,
    },
    await operationsCheck(client),
    await modelCheck(client, config),
    await skillsCheck(client),
  ];
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
