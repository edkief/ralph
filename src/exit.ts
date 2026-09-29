/**
 * Process exit codes. Kept numerically compatible with the bash Ralph so
 * existing supervisors (and k8s restart policies) keep their meaning.
 */
export const ExitCode = {
  /** Every task passes; the run finished the backlog. */
  Complete: 0,
  /** Iteration budget exhausted with work still outstanding. */
  MaxIterations: 1,
  /** Agent raised BLOCKED and needs a human. */
  Blocked: 2,
  /** Agent raised DECIDE and needs a human decision. */
  Decide: 3,
  /** Bad config, missing files, or a failed preflight. */
  ConfigError: 4,
  /** The model provider or opencode server is unusable. */
  ProviderError: 5,
  /** Iterations ran but stopped making progress. */
  Stalled: 6,
  /** SIGINT/SIGTERM. */
  Interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
