import { afterEach, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from './helpers/fake-server.js';
import { OpencodeClient } from '../src/opencode/client.js';
import { operationsCheck } from '../src/opencode/preflight.js';

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function check(options: Partial<Parameters<typeof startFakeServer>[0]> = {}) {
  server = await startFakeServer({ script: [], ...options });
  return operationsCheck(new OpencodeClient({ baseUrl: server.url }));
}

describe('operationsCheck', () => {
  it('passes a server that takes permission replies the way they are sent', async () => {
    const result = await check();

    expect(result).toMatchObject({ name: 'api', ok: true });
  });

  it('fails a server that wants the permission decision under another name', async () => {
    const result = await check({ replyField: 'reply' });

    expect(result).toMatchObject({ name: 'api', ok: false, fatal: true });
    expect(result.detail).toBe(
      'session.permission.reply does not accept "decision" (it takes: reply, message) — unsupported opencode version',
    );
  });
});
