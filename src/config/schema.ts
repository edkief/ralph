import { z } from 'zod';
import { REQUEST_KINDS } from '../human/request.js';

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
  /**
   * What to do with a task that ran out of time or context `maxTimeoutsPerTask`
   * times: `stop` the run, `propose` a split into smaller tasks and stop, or
   * `split` it and carry on.
   */
  onRepeatedTimeout: z.enum(['stop', 'propose', 'split']).default('propose'),
  /** Times a task and its descendants may be split before a stall just stops the run. */
  maxSplitDepth: z.number().int().min(0).default(1),
});

/**
 * Assessing a task before its first attempt. A short triage turn estimates
 * the working time the task needs; one estimated over the threshold is split
 * before any time is spent on it, instead of after it ran out of time.
 */
const AssessSchema = z.object({
  /**
   * `off` attempts every task as it is. `propose` has the agent propose a
   * split of a task that is too big, then stops or waits for a person;
   * `split` applies the split and carries on.
   */
  mode: z.enum(['off', 'propose', 'split']).default('off'),
  /** A task estimated to need more than this is split. Defaults to `timeouts.iterationMs`. */
  thresholdMs: z.number().int().positive().optional(),
  /** Working time for the triage turn; then it is interrupted and the task attempted as it is. */
  timeoutMs: z.number().int().positive().default(5 * 60_000),
});

/**
 * A second agent between the coding agent and a person. Where the loop would
 * ask a person (a blocker, a decision, a stall, a split to review, a spent
 * budget), the escalation agent gets the request first: it settles it with
 * one of the answers a person could give, or passes it on with its analysis.
 */
const EscalationSchema = z.object({
  enabled: z.boolean().default(false),
  /** The requests the agent gets before a person. */
  kinds: z.array(z.enum(REQUEST_KINDS)).default([...REQUEST_KINDS]),
  /** `provider/model` for the escalation turn; defaults to `plan.model`, then `model`. */
  model: z.string().optional(),
  /** Working time for one escalation turn; then it is cut off and the request goes to a person. */
  timeoutMs: z.number().int().positive().default(10 * 60_000),
  /**
   * Requests the agent may settle per task in a run (the budget counts as one
   * task). Past it, the request goes straight to a person, so the agent cannot
   * keep sending the coding agent back into the same wall.
   */
  maxPerTask: z.number().int().min(0).default(2),
});

/**
 * Publishing commits. The loop pushes, never the agent, whose `git push` stays
 * denied. `iteration` pushes after every iteration that committed; `end`
 * pushes once when the run finishes.
 *
 * `records` is when Ralph commits its own records (decisions, handoffs,
 * assessments, split proposals, the run journal, kept artifacts), so a run can
 * resume from the repository on another machine: after each iteration, once
 * when the run ends, or never.
 */
const GitSchema = z.object({
  push: z.enum(['never', 'iteration', 'end']).default('never'),
  records: z.enum(['iteration', 'end', 'never']).default('end'),
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
 * The web UI. `ralph ui` always serves it; `enabled` also starts it beside the
 * loop. Loopback by default: reading needs no authentication, and actions
 * (answering the loop, stopping it) are only taken on loopback, with `token`,
 * or when `actions` is `open`.
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
  /**
   * When the loop needs a person (a decision, a blocker, a stall, a proposed
   * split, a spent budget), wait for their answer from the web UI or
   * `ralph respond` instead of exiting. Defaults to `enabled`.
   */
  wait: z.boolean().optional(),
  /**
   * A secret that requests for actions must carry. Required for actions when
   * the UI is reachable from other hosts; open the UI with `?token=<it>`.
   */
  token: z.string().min(1).optional(),
  /**
   * `open` takes actions from other hosts without a token, for a UI whose
   * access is controlled in front of it (a reverse proxy that authenticates).
   * `guarded`, the default, takes them only on loopback or with `token`.
   */
  actions: z.enum(['guarded', 'open']).optional(),
});

/**
 * Estimating what the project's model work cost, for the web UI's Metrics
 * tab. `power` charges electricity on inference time, for self-hosted models:
 * hours generating × watts / 1000 × price per kWh. Nothing is estimated until
 * `power.watts` and `power.pricePerKwh` are set.
 */
const CostSchema = z.object({
  estimator: z.enum(['power']).default('power'),
  /** Shown beside every estimate; not converted. */
  currency: z.string().min(1).default('USD'),
  power: z
    .object({
      /** What the machine draws while a model generates. */
      watts: z.number().positive().optional(),
      pricePerKwh: z.number().min(0).optional(),
      /** Per `provider/model`, where a model runs on other hardware or draws differently. */
      models: z.record(z.string(), z.object({ watts: z.number().positive() })).default({}),
    })
    .prefault({}),
});

const MetricsSchema = z.object({
  cost: CostSchema.prefault({}),
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
  assess: AssessSchema.prefault({}),
  escalation: EscalationSchema.prefault({}),
  permissions: PermissionsSchema.prefault({}),
  git: GitSchema.prefault({}),
  plan: PlanSchema.prefault({}),
  ui: UiSchema.prefault({}),
  metrics: MetricsSchema.prefault({}),
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
export type EscalationConfig = z.infer<typeof EscalationSchema>;
export type CostConfig = z.infer<typeof CostSchema>;
