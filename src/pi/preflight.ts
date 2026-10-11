import type { Config } from '../config/schema.js';
import type { CheckResult } from '../harness/types.js';

/** Filled in with the doctor checks. */
export async function piChecks(_config: Config, _options: unknown): Promise<CheckResult[]> {
  return [];
}
