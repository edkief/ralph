import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PermissionsConfig } from '../config/schema.js';
import type { PermissionRequest } from '../harness/events.js';

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionDecision {
  /** `ask`: a person decides, or, with none to ask, it is rejected. */
  reply: PermissionReply | 'ask';
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
    reply: config.fallback === 'allow' ? 'once' : config.fallback === 'ask' ? 'ask' : 'reject',
    reason: 'fallback',
  };
}

/**
 * Permission actions that write files: opencode's editing tools (`edit`, `write`, `patch`, `multiedit`), pi's
 * (`write`, `edit`) and the tools an extension adds, which join the word to others with `_` or `-`
 * (`apply_patch`, `multi_edit`). A letter or digit beside the word makes it another word (`editor`, `rewrite`).
 */
const WRITE_ACTIONS = /(?:^|[^a-z0-9])(?:edit|write|patch|multiedit)(?:[^a-z0-9]|$)/i;

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
