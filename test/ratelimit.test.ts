import { describe, expect, it } from 'vitest';
import { isRateLimit } from '../src/harness/ratelimit.js';

describe('isRateLimit', () => {
  it.each([
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"The Token Plan usage limit has been reached. To avoid interruption, please upgrade your plan or buy credits and turn on auto consumption. (2067)"}}',
    'Rate limit reached for requests',
    'Too Many Requests',
    'You exceeded your current quota, please check your plan and billing details',
    'insufficient_quota',
    'RESOURCE_EXHAUSTED: Quota exceeded for metric',
    "You've hit your usage limit",
    'Server requested 3600s retry delay (max: 60s). Provider request failed',
  ])('recognises %j', (message) => {
    expect(isRateLimit(message)).toBe(true);
  });

  it('recognises a 429 status whatever the message', () => {
    expect(isRateLimit('upstream said no', 429)).toBe(true);
  });

  it.each(['503 upstream unavailable', 'ECONNREFUSED', 'prompt is too long: 215000 tokens > 200000 maximum', ''])(
    'does not mistake %j for a rate limit',
    (message) => {
      expect(isRateLimit(message, 503)).toBe(false);
    },
  );
});
