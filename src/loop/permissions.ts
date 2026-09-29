import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PermissionsConfig } from '../config/schema.js';
import type { PermissionRequest } from '../opencode/events.js';

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionDecision {
  reply: PermissionReply;
  /** The pattern that decided it, for the audit log. */
  matched?: string;
  reason: 'deny-rule' | 'allow-rule' | 'fallback' | 'outside-scope';
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

/** Permission actions that write files, as opencode names its editing tools. */
const WRITE_ACTIONS = /\b(edit|write|patch|multiedit)\b/i;

/**
 * Narrow a policy so file writes are allowed only inside `scope`. Deny rules
 * still apply first. A write request that names no path cannot be judged
 * here and falls through to the base policy.
 */
export function restrictWrites(
  config: PermissionsConfig,
  projectRoot: string,
  scope: string,
): (request: PermissionRequest) => PermissionDecision {
  const scopeDir = resolve(projectRoot, scope);
  return (request) => {
    const decision = decidePermission(request, config);
    if (decision.reply === 'reject' || !WRITE_ACTIONS.test(request.action)) return decision;

    const outside = request.resources.find((resource) => !isInside(scopeDir, resolve(projectRoot, resource)));
    return outside ? { reply: 'reject', matched: outside, reason: 'outside-scope' } : decision;
  };
}

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
