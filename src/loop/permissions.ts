import type { PermissionsConfig } from '../config/schema.js';
import type { PermissionRequest } from '../opencode/events.js';

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionDecision {
  reply: PermissionReply;
  /** The pattern that decided it, for the audit log. */
  matched?: string;
  reason: 'deny-rule' | 'allow-rule' | 'fallback';
}

/**
 * Decide a permission request without a human in the loop.
 *
 * Deny rules win over allow rules so a broad allow list can never re-enable
 * something explicitly forbidden. Patterns are plain substrings matched
 * case-insensitively against the action and each resource, which keeps rules
 * readable in config (`"git push"`, `"rm -rf /"`).
 */
export function decidePermission(
  request: PermissionRequest,
  config: PermissionsConfig,
): PermissionDecision {
  const haystack = [request.action, ...request.resources, request.message ?? '']
    .join(' ')
    .toLowerCase();

  const denied = config.deny.find((pattern) => haystack.includes(pattern.toLowerCase()));
  if (denied) return { reply: 'reject', matched: denied, reason: 'deny-rule' };

  const allowed = config.allow.find((pattern) => haystack.includes(pattern.toLowerCase()));
  if (allowed) return { reply: 'always', matched: allowed, reason: 'allow-rule' };

  return {
    reply: config.fallback === 'allow' ? 'once' : 'reject',
    reason: 'fallback',
  };
}
