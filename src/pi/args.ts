import type { PiConfig } from '../config/schema.js';
import { GATE_EXTENSION } from './gate.js';

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
    '--extension',
    GATE_EXTENSION,
  ];
}
