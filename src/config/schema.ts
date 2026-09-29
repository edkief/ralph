import { z } from 'zod';

/** Where Ralph finds the server: attach to a URL, or spawn its own. */
const ServerSchema = z.object({
  url: z.string().url().optional(),
  password: z.string().optional(),
  hostname: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(0),
  startupTimeoutMs: z.number().int().positive().default(60_000),
  shutdownTimeoutMs: z.number().int().positive().default(10_000),
});

const TimeoutsSchema = z.object({
  /** Hard ceiling for one iteration before it is interrupted. */
  iterationMs: z.number().int().positive().default(30 * 60_000),
  /** No interesting event for this long means the agent is wedged. */
  inactivityMs: z.number().int().positive().default(180_000),
});

const RetriesSchema = z.object({
  /** Provider retries tolerated inside one iteration before giving up. */
  providerRetriesPerIteration: z.number().int().min(0).default(3),
  /** Whole-iteration retries after a provider or timeout failure. */
  iterationRetries: z.number().int().min(0).default(1),
  backoffMs: z.number().int().min(0).default(10_000),
});

const StallSchema = z.object({
  /** Consecutive iterations with no commit and no task flip before aborting. */
  maxUnproductiveIterations: z.number().int().positive().default(3),
});

/**
 * Permission policy for unattended runs. `deny` wins over `allow`; anything
 * unmatched follows `fallback`. Patterns are matched against the permission
 * action and its resources.
 */
const PermissionsSchema = z.object({
  fallback: z.enum(['allow', 'reject']).default('allow'),
  deny: z.array(z.string()).default([
    'git push',
    'git remote',
    'rm -rf /',
    'shutdown',
    'reboot',
  ]),
  allow: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  projectRoot: z.string(),
  agentDir: z.string().default('.agent'),
  maxIterations: z.number().int().positive().default(10),
  /** `provider/model` as opencode names it; omitted means server default. */
  model: z.string().optional(),
  /** opencode agent (subagent profile) to run as. */
  agent: z.string().optional(),
  /** Name the next task explicitly in the prompt instead of letting the model choose. */
  pinTask: z.boolean().default(true),
  pauseBetweenIterationsMs: z.number().int().min(0).default(2_000),
  server: ServerSchema.prefault({}),
  timeouts: TimeoutsSchema.prefault({}),
  retries: RetriesSchema.prefault({}),
  stall: StallSchema.prefault({}),
  permissions: PermissionsSchema.prefault({}),
  log: z
    .object({
      format: z.enum(['text', 'json']).default('text'),
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsSchema>;
