import { describe, expect, it } from 'vitest';
import { decidePermission, restrictWrites } from '../src/loop/permissions.js';
import { ConfigSchema } from '../src/config/schema.js';

const defaults = ConfigSchema.parse({ projectRoot: '/tmp' }).permissions;

const request = (action: string, resources: string[]) => ({
  id: 'per_1',
  sessionID: 'ses_1',
  action,
  resources,
});

describe('decidePermission', () => {
  it('rejects denied commands', () => {
    const decision = decidePermission(request('shell', ['git push origin main']), defaults);
    expect(decision.reply).toBe('reject');
    expect(decision.matched).toBe('git push');
  });

  it('allows anything else by default so unattended runs proceed', () => {
    expect(decidePermission(request('shell', ['npm test']), defaults).reply).toBe('once');
  });

  it('honours an explicit allow list with "always"', () => {
    const config = { ...defaults, allow: ['npm test'] };
    const decision = decidePermission(request('shell', ['npm test']), config);
    expect(decision.reply).toBe('always');
    expect(decision.reason).toBe('allow-rule');
  });

  it('lets deny beat allow', () => {
    const config = { ...defaults, allow: ['git'], deny: ['git push'] };
    expect(decidePermission(request('shell', ['git push']), config).reply).toBe('reject');
  });

  it('can be locked down with a reject fallback', () => {
    const config = { ...defaults, fallback: 'reject' as const };
    expect(decidePermission(request('shell', ['ls']), config).reply).toBe('reject');
  });

  it('matches case-insensitively across action, resources and message', () => {
    const config = { ...defaults, deny: ['SHUTDOWN'] };
    expect(decidePermission(request('shell', ['sudo shutdown now']), config).reply).toBe('reject');
  });
});

describe('restrictWrites', () => {
  const policy = restrictWrites(defaults, '/project', '.ralph');

  it('allows writes inside the scope, by relative or absolute path', () => {
    expect(policy(request('edit', ['.ralph/prd/PRD.md'])).reply).toBe('once');
    expect(policy(request('write', ['/project/.ralph/tasks.json'])).reply).toBe('once');
  });

  it('rejects a write that reaches outside the scope', () => {
    const decision = policy(request('edit', ['.ralph/tasks.json', 'src/index.ts']));
    expect(decision).toEqual({ reply: 'reject', matched: 'src/index.ts', reason: 'outside-scope' });
    expect(policy(request('edit', ['.ralph/../package.json'])).reply).toBe('reject');
    expect(policy(request('patch', ['/elsewhere/.ralph/x'])).reply).toBe('reject');
  });

  it('does not mistake a sibling with the same prefix for the scope', () => {
    expect(policy(request('edit', ['.ralph-old/notes.md'])).reply).toBe('reject');
    expect(policy(request('edit', ['.ralph/..notes.md'])).reply).toBe('once');
  });

  it('leaves reads and other actions to the base policy, deny rules included', () => {
    expect(policy(request('read', ['src/index.ts'])).reply).toBe('once');
    expect(policy(request('shell', ['git push'])).reply).toBe('reject');
  });

  it('falls back to the base policy for a write that names no path', () => {
    expect(policy(request('edit', [])).reply).toBe('once');
  });
});
