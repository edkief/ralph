import { fileURLToPath } from 'node:url';
import type { Config, PiConfig } from '../config/schema.js';
import { GATE_EXTENSION } from './gate.js';

/** The extension that registers the Playwright MCP server, from `src/pi/` and from `dist/pi/` alike. */
export const PLAYWRIGHT_EXTENSION = fileURLToPath(new URL('../../extensions/ralph-playwright.mjs', import.meta.url));

/**
 * The command line of a pi process Ralph starts: in a session directory, or with no session (a probe).
 *
 * Project trust is always given one way or the other, so a user's own `defaultProjectTrust` never decides it.
 * The gate comes last: pi runs `tool_call` handlers in the order the extensions on its command line load, and
 * one that runs after the gate could change a call the gate has allowed. Extensions pi finds for itself (the
 * project's `.pi/extensions`, the user's) load after these, which `ralph doctor` warns about.
 */
export function piArguments(pi: PiConfig, sessionDir: string | undefined): string[] {
  return [
    '--mode',
    'rpc',
    ...(sessionDir ? ['--session-dir', sessionDir] : ['--no-session']),
    pi.trustProject ? '--approve' : '--no-approve',
    ...(pi.thinking ? ['--thinking', pi.thinking] : []),
    ...pi.args,
    ...(pi.browser === 'mcp' ? ['--extension', PLAYWRIGHT_EXTENSION] : []),
    '--extension',
    GATE_EXTENSION,
  ];
}

/** How long the gate waits on Ralph beyond `timeouts.askMs`, which Ralph keeps to itself. */
const GATE_GRACE_MS = 30_000;

/**
 * pi's environment. The gate waits on Ralph for as long as `timeouts.askMs` lets an ask last, and a little
 * longer, then blocks the call itself; with no limit on asks it waits for good, which the turn's end or
 * its stop ends. With `pi.browser` "mcp", it also names the Playwright server to register.
 */
export function piEnvironment(config: Config): NodeJS.ProcessEnv {
  const { askMs } = config.timeouts;
  // Not ones the environment brought along: Ralph alone says how long the gate waits, and which server to start.
  const { RALPH_GATE_TIMEOUT_MS: _timeout, RALPH_PLAYWRIGHT_MCP: _server, ...env } = process.env;
  return {
    ...env,
    ...(askMs > 0 ? { RALPH_GATE_TIMEOUT_MS: String(askMs + GATE_GRACE_MS) } : {}),
    ...(config.pi.browser === 'mcp' ? { RALPH_PLAYWRIGHT_MCP: JSON.stringify(config.pi.playwrightMcp) } : {}),
  };
}

