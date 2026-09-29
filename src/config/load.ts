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
  );

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid Ralph configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
