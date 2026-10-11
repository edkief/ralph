import { describe, expect, it } from 'vitest';
import ralphPlaywright, { COMMAND, SERVER, serverOf } from '../extensions/ralph-playwright.mjs';
import { ConfigSchema } from '../src/config/schema.js';
import { PLAYWRIGHT_EXTENSION, piArguments, piEnvironment } from '../src/pi/args.js';
import { GATE_EXTENSION } from '../src/pi/gate.js';
import { piChecks, playwrightMcpCheck } from '../src/pi/preflight.js';
import { fakePi } from './helpers/pi.js';
import { quietLogger } from './helpers/pi-harness.js';

const config = (pi: Record<string, unknown> = {}) => ConfigSchema.parse({ projectRoot: process.cwd(), harness: 'pi', model: 'stub/stub-model', pi });

/** A stand-in for pi's extension API that records what the extension registers. */
function fakeApi() {
  const servers: Array<[string, Record<string, unknown>]> = [];
  const commands: string[] = [];
  return {
    servers,
    commands,
    api: {
      registerMcpServer: (name: string, server: Record<string, unknown>) => servers.push([name, server]),
      registerCommand: (name: string) => commands.push(name),
    },
  };
}

function withServer<T>(value: string | undefined, run: () => T): T {
  const before = process.env['RALPH_PLAYWRIGHT_MCP'];
  if (value === undefined) delete process.env['RALPH_PLAYWRIGHT_MCP'];
  else process.env['RALPH_PLAYWRIGHT_MCP'] = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env['RALPH_PLAYWRIGHT_MCP'];
    else process.env['RALPH_PLAYWRIGHT_MCP'] = before;
  }
}

describe('the Playwright extension', () => {
  it('registers the server Ralph names, declared to the model, then its command', () => {
    const { api, servers, commands } = fakeApi();
    withServer(JSON.stringify({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] }), () => ralphPlaywright(api));
    expect(servers).toEqual([[SERVER, expect.objectContaining({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'], exposure: 'direct' })]]);
    expect(commands).toEqual([COMMAND]);
  });

  it('registers nothing, command included, without a server it can read', () => {
    for (const value of [undefined, '', 'not json', '{"args":[]}']) {
      const { api, servers, commands } = fakeApi();
      withServer(value, () => ralphPlaywright(api));
      expect([servers, commands]).toEqual([[], []]);
    }
    expect(serverOf('{"command":"npx","args":["a",1]}')).toEqual({ command: 'npx', args: ['a'] });
  });
});

describe('pi.browser', () => {
  it('is the skill by default: no Playwright extension, no server in the environment', () => {
    const defaults = config();
    expect(defaults.pi.browser).toBe('skill');
    expect(piArguments(defaults.pi, undefined)).not.toContain(PLAYWRIGHT_EXTENSION);
    expect(piEnvironment(defaults)['RALPH_PLAYWRIGHT_MCP']).toBeUndefined();
  });

  it('with mcp, loads the Playwright extension before the gate and names the server for it', () => {
    const mcp = config({ browser: 'mcp' });
    const args = piArguments(mcp.pi, undefined);
    expect(args.slice(-4)).toEqual(['--extension', PLAYWRIGHT_EXTENSION, '--extension', GATE_EXTENSION]);
    expect(JSON.parse(piEnvironment(mcp)['RALPH_PLAYWRIGHT_MCP'] ?? '')).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--browser', 'chromium', '--output-dir', '.playwright-mcp'],
    });
  });
});

describe('the browser check, by MCP', () => {
  it('passes when the extension registered the server and its command is there', async () => {
    const pi = fakePi();
    const checks = await piChecks(config({ browser: 'mcp', binary: pi.binary, playwrightMcp: { command: 'node' } }), { cwd: process.cwd(), logger: quietLogger });
    expect(checks.find((check) => check.name === 'browser')).toMatchObject({ ok: true, fatal: false, detail: expect.stringContaining('Playwright MCP') });
  });

  it('says what is missing', async () => {
    expect(await playwrightMcpCheck(false, '/nowhere/npx')).toMatchObject({
      ok: false,
      fatal: false,
      detail: expect.stringMatching(/did not register the server.*\/nowhere\/npx.* is not installed/),
    });
  });
});
