import { describe, expect, it } from 'vitest';
import { isContextOverflow } from '../src/opencode/overflow.js';
import { errorMessage } from '../src/opencode/events.js';

describe('isContextOverflow', () => {
  it.each([
    'prompt is too long: 215000 tokens > 200000 maximum',
    "This model's maximum context length is 32768 tokens. However, your messages resulted in 40000 tokens.",
    'the request exceeds the available context size, try increasing it',
    'input (40000 tokens) is longer than the model\'s context length (32768 tokens)',
    'Error: context_length_exceeded',
    'request (41021 tokens) exceeds the context window',
    'Request Entity Too Large',
  ])('recognises %j', (message) => {
    expect(isContextOverflow(message)).toBe(true);
  });

  it.each([
    'Rate limit reached: too many tokens per minute',
    'Too many requests',
    'Service unavailable: upstream timed out',
    'invalid tool schema',
    '',
  ])('does not mistake %j for an overflow', (message) => {
    expect(isContextOverflow(message)).toBe(false);
  });
});

describe('errorMessage', () => {
  it('reads the message from every error shape the server sends', () => {
    expect(errorMessage({ type: 'unknown', message: 'v2' })).toBe('v2');
    expect(errorMessage({ name: 'ContextOverflowError', data: { message: 'v1' } })).toBe('v1');
    expect(errorMessage('bare')).toBe('bare');
    expect(errorMessage({ name: 'OnlyName' })).toBe('OnlyName');
    expect(errorMessage(undefined)).toBeUndefined();
    expect(errorMessage('')).toBeUndefined();
  });
});
