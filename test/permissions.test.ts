import { describe, expect, it } from 'vitest';
import { decidePermission } from '../src/loop/permissions.js';
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
