import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EventOf, PermissionRequest } from '../harness/events.js';
import type { PermissionReply } from '../loop/permissions.js';
import type { PiFrame } from './frames.js';

/**
 * Ralph's side of the permission gate: the extension in extensions/ralph-gate.mjs, which Ralph loads into
 * every pi process, puts each tool call to Ralph as an `input` dialog, and the call runs only if Ralph
 * answers `{"allow":true}`. The constants below are the other half of that file's.
 */

/** The title of a gate dialog. */
export const GATE_TITLE = 'ralph:gate';

/** The command the extension registers last, which `get_commands` lists once it has loaded. */
export const GATE_COMMAND = 'ralph-gate';

/** The version of the request the extension sends. */
export const GATE_VERSION = 1;

/** Where the extension is, from `src/pi/` and from `dist/pi/` alike. */
export const GATE_EXTENSION = fileURLToPath(new URL('../../extensions/ralph-gate.mjs', import.meta.url));

/** The request in a gate dialog's placeholder. */
const GateCallSchema = z.object({
  v: z.literal(GATE_VERSION),
  id: z.string().optional(),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

export type GateCall = z.infer<typeof GateCallSchema>;

export type GateFrame = { id: string } & ({ call: GateCall } | { malformed: string });

/**
 * A gate dialog in what pi wrote, or nothing for any other frame. A dialog under the gate's title that is
 * not a request Ralph understands is `malformed`, and gets blocked: it must never wait on an answer.
 */
export function parseGateFrame(frame: PiFrame): GateFrame | undefined {
  if (frame['type'] !== 'extension_ui_request' || frame['method'] !== 'input' || frame['title'] !== GATE_TITLE) return undefined;
  const id = typeof frame['id'] === 'string' ? frame['id'] : undefined;
  if (!id) return undefined;
  const placeholder = frame['placeholder'];
  let raw: unknown;
  try {
    raw = JSON.parse(typeof placeholder === 'string' ? placeholder : '');
  } catch {
    return { id, malformed: 'the request is not JSON' };
  }
  const call = GateCallSchema.safeParse(raw);
  return call.success ? { id, call: call.data } : { id, malformed: call.error.issues[0]?.message ?? 'the request has the wrong shape' };
}

/** Shown in place of a path a file tool was given none of; it resolves outside any write scope. */
export const NO_PATH = '(no path)';

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'grep']);
/** Tools that write, which are judged by their path whatever else is missing. */
const WRITING_TOOLS = new Set(['write', 'edit']);
/** Where an unknown tool is likely to keep the file it works on. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file'];

/**
 * What the policy judges for a tool call: the tool's name as the action, and as resources what it works
 * on (a command, a path), so a `deny` pattern such as `git push` matches the command and the write scope
 * reads the path. An unknown tool has its input in the message as well, where a pattern can match it.
 */
export function permissionOf(call: GateCall, id: string, session: string): PermissionRequest {
  const { tool, input } = call;
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const base = { id, session, action: tool };

  if (tool === 'bash') {
    const command = text(input['command']);
    return { ...base, resources: [command ?? JSON.stringify(input)] };
  }
  if (FILE_TOOLS.has(tool)) {
    const path = text(input['path']);
    const resources = [path ?? (WRITING_TOOLS.has(tool) ? NO_PATH : '.')];
    const pattern = text(input['pattern']);
    return { ...base, resources: pattern ? [...resources, pattern] : resources };
  }
  const path = PATH_KEYS.map((key) => text(input[key])).find((found) => found !== undefined);
  return { ...base, resources: [path ?? JSON.stringify(input)], message: JSON.stringify(input) };
}

/** The permission event for a gate dialog. `gate` says that it is a call being judged, not a pause the agent chose. */
export function permissionEvent(call: GateCall, id: string, session: string, created: number): EventOf<'permission.asked'> {
  return { type: 'permission.asked', created, gate: true, ...permissionOf(call, id, session) };
}

/** What the extension is answered with: allowed for a person's or a rule's yes, blocked for anything else. */
export function gateAnswer(reply: PermissionReply, reason?: string): string {
  return reply === 'once' || reply === 'always' ? JSON.stringify({ allow: true }) : JSON.stringify({ allow: false, reason: blockedReason(reason) });
}

function blockedReason(reason: string | undefined): string {
  return `Ralph's permissions do not allow this${reason ? `: ${reason}` : ''}. Do not try another way round it; carry on without it.`;
}
