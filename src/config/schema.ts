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
  /** Working time for one iteration; then the agent is asked to wrap up. */
  iterationMs: z.number().int().positive().default(30 * 60_000),
  /** No interesting event for this long means the agent is wedged. */
  inactivityMs: z.number().int().positive().default(180_000),
  /**
   * Time the agent gets to hand off its work once the iteration runs out of
   * time or goes quiet, on top of `iterationMs`. 0 interrupts it outright.
   */
  wrapUpMs: z.number().int().min(0).default(10 * 60_000),
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
  /** Times one task may run out of time in a run before the run stops. */
  maxTimeoutsPerTask: z.number().int().positive().default(2),
});

/**
 * Publishing commits. The loop pushes, never the agent, whose `git push` stays
 * denied. `iteration` pushes after every iteration that committed; `end`
 * pushes once when the run finishes.
 */
const GitSchema = z.object({
  push: z.enum(['never', 'iteration', 'end']).default('never'),
  remote: z.string().default('origin'),
  pushTimeoutMs: z.number().int().positive().default(120_000),
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

/** The `ralph init` interview, in which the agent writes the plan with the user. */
const PlanSchema = z.object({
  /** Planning is a one-off that rewards a stronger model than the loop needs; defaults to `model`. */
  model: z.string().optional(),
  /** Agent turns before the interview gives up, fix-up turns included. */
  maxTurns: z.number().int().positive().default(30),
  /** Times the agent is sent back to fix a plan that fails validation. */
  maxFixAttempts: z.number().int().min(0).default(2),
});

/**
 * The read-only web UI. `ralph ui` always serves it; `enabled` also starts it
 * beside the loop. Loopback by default: it has no authentication.
 */
const UiSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4280),
  /**
   * The path prefix a reverse proxy serves the UI under, e.g. `/ralph/ws-1`.
   * The server strips it; the app's own URLs are relative, so they follow.
   */
  basePath: z
    .string()
    .regex(/^(\/[^/?#]+)*\/?$/, 'must be empty or an absolute path such as /ralph/ws-1')
    .default(''),
});

export const ConfigSchema = z.object({
  projectRoot: z.string(),
  /**
   * Ralph's project folder, relative to projectRoot. loadConfig resolves it:
   * an explicit value wins, else `.ralph/`, else a legacy `.agent/`.
   */
  ralphDir: z.string().default('.ralph'),
  /** @deprecated Former name of ralphDir; loadConfig folds it in and drops it. */
  agentDir: z.string().optional(),
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
  git: GitSchema.prefault({}),
  plan: PlanSchema.prefault({}),
  ui: UiSchema.prefault({}),
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
export type UiConfig = z.infer<typeof UiSchema>;
