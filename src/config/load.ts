import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ConfigSchema, type Config } from './schema.js';

export class ConfigError extends Error {}

/** Deep-merge plain objects; later sources win. Arrays are replaced, not merged. */
function merge(base: unknown, next: unknown): unknown {
  if (next === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(next)) return next;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    out[key] = merge(out[key], value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`Expected a number, got "${value}"`);
  return parsed;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return !['0', 'false', 'no', 'off', ''].includes(value.toLowerCase());
}

/**
 * Environment overrides, RALPH_ prefixed. Only the knobs worth setting from a
 * k8s manifest are exposed; everything else belongs in ralph.config.json.
 */
function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    ralphDir: env['RALPH_DIR'] || undefined,
    maxIterations: num(env['RALPH_MAX_ITERATIONS']),
    model: env['RALPH_MODEL'],
    agent: env['RALPH_AGENT'],
    pinTask: bool(env['RALPH_PIN_TASK']),
    server: {
      url: env['RALPH_SERVER_URL'],
      password: env['RALPH_SERVER_PASSWORD'],
      hostname: env['RALPH_SERVER_HOSTNAME'],
      port: num(env['RALPH_SERVER_PORT']),
    },
    timeouts: {
      iterationMs: num(env['RALPH_ITERATION_TIMEOUT_MS']),
      inactivityMs: num(env['RALPH_INACTIVITY_TIMEOUT_MS']),
      wrapUpMs: num(env['RALPH_WRAP_UP_TIMEOUT_MS']),
    },
    plan: {
      model: env['RALPH_PLAN_MODEL'],
    },
    git: {
      push: env['RALPH_GIT_PUSH'],
      remote: env['RALPH_GIT_REMOTE'],
    },
    ui: {
      enabled: bool(env['RALPH_UI']),
      host: env['RALPH_UI_HOST'] || undefined,
      port: num(env['RALPH_UI_PORT']),
      basePath: env['RALPH_UI_BASE_PATH'] || undefined,
    },
    log: {
      format: env['RALPH_LOG_FORMAT'],
      level: env['RALPH_LOG_LEVEL'],
    },
  };
}

export interface LoadOptions {
  projectRoot: string;
  overrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** Receives deprecation notices; defaults to stderr. */
  onWarning?: (message: string) => void;
}

export const RALPH_DIR = '.ralph';
export const LEGACY_DIR = '.agent';

/**
 * Pick Ralph's project folder. An explicit `ralphDir` (or the deprecated
 * `agentDir`) wins; otherwise `.ralph/` if present, then a legacy `.agent/`,
 * then `.ralph/` as the default for a project that has neither yet.
 */
function resolveRalphDir(
  projectRoot: string,
  merged: Record<string, unknown>,
  warn: (message: string) => void,
): unknown {
  if (merged['ralphDir'] !== undefined) {
    if (merged['agentDir'] !== undefined) warn('both "ralphDir" and the deprecated "agentDir" are set; using "ralphDir"');
    return merged['ralphDir'];
  }
  if (merged['agentDir'] !== undefined) {
    warn('the "agentDir" setting is deprecated; rename it to "ralphDir"');
    return merged['agentDir'];
  }
  if (existsSync(resolve(projectRoot, RALPH_DIR))) return RALPH_DIR;
  if (existsSync(resolve(projectRoot, LEGACY_DIR))) {
    warn(`${LEGACY_DIR}/ is deprecated; rename it with \`git mv ${LEGACY_DIR} ${RALPH_DIR}\``);
    return LEGACY_DIR;
  }
  return RALPH_DIR;
}

/**
 * Resolve config from defaults < ralph.config.json < RALPH_* env < CLI flags.
 * Throws ConfigError with a readable message when validation fails.
 */
export function loadConfig(options: LoadOptions): Config {
  const projectRoot = resolve(options.projectRoot);
  const env = options.env ?? process.env;
  const configPath = options.configPath
    ? isAbsolute(options.configPath)
      ? options.configPath
      : resolve(projectRoot, options.configPath)
    : resolve(projectRoot, 'ralph.config.json');

  let fileConfig: unknown = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (cause) {
      throw new ConfigError(`Could not parse ${configPath}: ${(cause as Error).message}`);
    }
  } else if (options.configPath) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  const merged = [fileConfig, fromEnv(env), options.overrides ?? {}].reduce(
    (acc, source) => merge(acc, source),
    { projectRoot } as unknown,
  ) as Record<string, unknown>;

  const warn = options.onWarning ?? ((message: string) => process.stderr.write(`warn ${message}\n`));
  const ralphDir = resolveRalphDir(projectRoot, merged, warn);

  const parsed = ConfigSchema.safeParse({ ...merged, ralphDir });
  if (!parsed.success) {
    throw new ConfigError(`Invalid Ralph configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const { agentDir: _alias, ...config } = parsed.data;
  return config;
}
