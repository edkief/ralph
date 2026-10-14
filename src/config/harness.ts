/** The agent backends Ralph can drive. */
export const HARNESS_NAMES = ['opencode', 'pi'] as const;

export type HarnessName = (typeof HARNESS_NAMES)[number];

/** The harness a config that names none runs. It was opencode until pi became the default (#81). */
export const DEFAULT_HARNESS: HarnessName = 'pi';

/**
 * The top-level settings that belong to one harness alone. One set while
 * another harness is chosen does nothing, which `loadConfig` warns about.
 * Everything not listed (`model`, `timeouts`, ...) applies to every harness.
 */
export const HARNESS_SETTINGS: Record<HarnessName, readonly string[]> = {
  opencode: ['agent', 'server'],
  pi: ['pi'],
};
