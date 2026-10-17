/**
 * Provider messages that mean the account is over a rate limit or out of its
 * plan or quota. Retrying in seconds is pointless: such a limit lifts in
 * minutes or hours, so the loop waits it out instead.
 */
const PATTERNS = [
  /^429\b/,
  /rate[_ ]?limit/i,
  /too many requests/i,
  /usage limit/i,
  /insufficient_quota/i,
  /quota (?:has been )?exceeded|exceeded (?:your |the )?(?:current )?quota/i,
  /resource_exhausted/i,
];

export function isRateLimit(message: string, status?: number): boolean {
  return status === 429 || PATTERNS.some((pattern) => pattern.test(message));
}
