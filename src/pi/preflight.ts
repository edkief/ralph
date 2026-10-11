import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config/schema.js';
import type { CheckResult } from '../harness/types.js';
import type { Logger } from '../report/logger.js';
import { GATE_EXTENSION, gateLoaded, gateMissingMessage } from './gate.js';
import { PiProcess } from './rpc.js';

const run = promisify(execFile);

/**
 * The pi versions whose RPC protocol this adapter was written and tested against: 1.1.0 onwards. pi 1.x
 * keeps its protocol within the major version, so the range stops short of 2.0. Widening it means recording
 * a session on the new version (test/fixtures/pi/capture/) and checking the fixtures still hold.
 */
export const PI_VERSION_RANGE = { min: [1, 1, 0], below: [2, 0, 0] } as const;

export const PI_VERSION_RANGE_TEXT = '>=1.1.0 <2';

/** pi's package. Before 1.0 it was `@mariozechner/pi-coding-agent`, now deprecated and frozen at 0.73.1. */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

const OLD_PI_PACKAGE = '@mariozechner/pi-coding-agent';

const PROBE_TIMEOUT_MS = 30_000;

type Version = readonly [number, number, number];

/**
 * What `pi --version` prints. pi writes it to stderr, so both streams are read; a pi that writes it to
 * stdout instead is no different.
 */
export async function piVersion(binary: string): Promise<string> {
  const { stdout, stderr } = await run(binary, ['--version'], { timeout: 15_000 });
  return `${stdout}${stderr}`.trim();
}

export function parseVersion(text: string): Version | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function inVersionRange(version: Version): boolean {
  return compare(version, PI_VERSION_RANGE.min) >= 0 && compare(version, PI_VERSION_RANGE.below) < 0;
}

export interface PiCheckOptions {
  cwd: string;
  logger: Logger;
  /** The command the browser skill drives; a test points it at a stand-in. */
  browserCli?: string;
}

/** The command the shipped `browser-check` skill (templates/skills/) tells the agent to run. */
export const BROWSER_CLI = 'playwright-cli';

/** The skill `ralph init` writes to `.agents/skills/`. */
export const BROWSER_SKILL = 'browser-check';

/**
 * The checks on pi: the executable runs and is a version this adapter speaks, the models the config names
 * are ones pi has, its skills, and that it loads the extension through which Ralph judges every tool call.
 * Without that extension pi runs everything unasked, so its absence is fatal.
 */
export async function piChecks(config: Config, options: PiCheckOptions): Promise<CheckResult[]> {
  const binary = await versionCheck(config.pi.binary);
  const checks: CheckResult[] = [binary];
  if (!binary.ok) return checks;

  const probed = await probe(config, options);
  if ('failure' in probed) return [...checks, { name: 'rpc', ok: false, detail: probed.failure, fatal: true }];

  checks.push(...modelChecks(config, probed), skillsCheck(probed.skills), await browserCheck(probed.skills, options.browserCli ?? BROWSER_CLI), gateCheck(probed.gate));
  return checks;
}

async function versionCheck(binary: string): Promise<CheckResult> {
  let output: string;
  try {
    output = await piVersion(binary);
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      name: 'pi',
      ok: false,
      detail: missing ? `\`${binary}\` is not installed or not on the PATH (npm install -g ${PI_PACKAGE})` : `\`${binary} --version\` failed: ${(cause as Error).message}`,
      fatal: true,
    };
  }
  const version = parseVersion(output);
  if (!version) return { name: 'pi', ok: false, detail: `\`${binary} --version\` printed "${output}", which is not a version`, fatal: true };
  const text = version.join('.');
  if (version[0] === 0) {
    return {
      name: 'pi',
      ok: false,
      detail:
        `${text} is the old ${OLD_PI_PACKAGE}, which is deprecated; Ralph needs ${PI_VERSION_RANGE_TEXT}: ` +
        `npm uninstall -g ${OLD_PI_PACKAGE} && npm install -g ${PI_PACKAGE}@${PI_VERSION_RANGE.min.slice(0, 2).join('.')}`,
      fatal: true,
    };
  }
  if (!inVersionRange(version)) {
    return {
      name: 'pi',
      ok: false,
      detail: `${text} is outside the versions Ralph is tested with (${PI_VERSION_RANGE_TEXT}): npm install -g ${PI_PACKAGE}@${PI_VERSION_RANGE.min.slice(0, 2).join('.')}`,
      fatal: true,
    };
  }
  return { name: 'pi', ok: true, detail: `${text} (tested with ${PI_VERSION_RANGE_TEXT})`, fatal: true };
}

interface Probed {
  /** `provider/id` of the models pi has credentials for. */
  models: string[];
  /** The model pi starts on when none is asked for. */
  defaultModel: string | undefined;
  skills: string[];
  /** pi lists the command of Ralph's permission extension. */
  gate: boolean;
}

/** Start a throwaway pi and ask it what it has. */
async function probe(config: Config, options: PiCheckOptions): Promise<Probed | { failure: string }> {
  const pi = PiProcess.spawn({
    binary: config.pi.binary,
    args: ['--mode', 'rpc', '--no-session', '--extension', GATE_EXTENSION, ...(config.pi.thinking ? ['--thinking', config.pi.thinking] : []), ...config.pi.args],
    cwd: options.cwd,
    shutdownTimeoutMs: 5_000,
    logger: options.logger,
  });
  try {
    const [state, models, commands] = await Promise.all([
      pi.request({ type: 'get_state' }, PROBE_TIMEOUT_MS),
      pi.request({ type: 'get_available_models' }, PROBE_TIMEOUT_MS),
      pi.request({ type: 'get_commands' }, PROBE_TIMEOUT_MS),
    ]);
    const named = (model: { provider?: string; id?: string } | null | undefined) => (model?.provider && model.id ? `${model.provider}/${model.id}` : undefined);
    const available = (models.data as { models?: Array<{ provider?: string; id?: string }> } | undefined)?.models ?? [];
    const commandList = (commands.data as { commands?: Array<{ name?: string; source?: string }> } | undefined)?.commands ?? [];
    return {
      models: available.flatMap((model) => named(model) ?? []),
      defaultModel: named((state.data as { model?: { provider?: string; id?: string } | null } | undefined)?.model),
      skills: commandList.filter((command) => command.source === 'skill').map((command) => (command.name ?? '').replace(/^skill:/, '')),
      gate: gateLoaded(commandList),
    };
  } catch (cause) {
    return { failure: `\`${config.pi.binary} --mode rpc\` did not answer: ${(cause as Error).message}` };
  } finally {
    await pi.stop().catch(() => undefined);
  }
}

/**
 * Every model the config names has to be one pi has credentials for, or the turn that asks for it fails on
 * `set_model`. Without any named, pi runs on its own default, which a machine with no provider set up lacks.
 */
function modelChecks(config: Config, probed: Probed): CheckResult[] {
  const wanted: Array<[string, string | undefined]> = [
    ['model', config.model],
    ['plan model', config.plan.model],
    ['escalation model', config.escalation.model],
  ];
  const named = wanted.flatMap(([label, model]): Array<[string, string]> => (model === undefined ? [] : [[label, model]]));
  if (named.length === 0) {
    return [
      probed.defaultModel
        ? { name: 'model', ok: true, detail: `using pi's default ${probed.defaultModel}; set \`model\` to be sure which`, fatal: false }
        : {
            name: 'model',
            ok: false,
            detail: 'pi has no default model and `model` is not set: set it to a `provider/model` from ~/.pi/agent/models.json (see the README)',
            fatal: true,
          },
    ];
  }
  const known = new Set(probed.models);
  return named.map(([label, model]) => {
    if (known.has(model)) return { name: label, ok: true, detail: model, fatal: false };
    const have = probed.models.slice(0, 6).join(', ');
    return {
      name: label,
      ok: false,
      detail: `pi has no model ${model}: define it in ~/.pi/agent/models.json (see the README). pi has: ${have || 'none'}${probed.models.length > 6 ? ', ...' : ''}`,
      fatal: true,
    };
  });
}

/** pi puts every tool call to Ralph, which judges it by `permissions` and the write scope of the turn. */
function gateCheck(loaded: boolean): CheckResult {
  return loaded
    ? { name: 'permissions', ok: true, detail: 'every tool call is put to Ralph before it runs (extensions/ralph-gate.mjs loaded)', fatal: true }
    : { name: 'permissions', ok: false, detail: gateMissingMessage(), fatal: true };
}

/**
 * Whether the agent can check a screen in a browser. pi has no MCP, so it does it by running playwright-cli
 * through `bash`, as the `browser-check` skill tells it: that takes the command, a Chromium for it to
 * drive and the skill. Not fatal: a project need not test in a browser.
 */
export async function browserCheck(skills: string[], cli: string): Promise<CheckResult> {
  const name = 'browser';
  const missing: string[] = [];
  let version: string | undefined;
  let chromium: boolean | undefined;

  try {
    version = (await run(cli, ['--version'], { timeout: 15_000 })).stdout.trim().split('\n')[0];
  } catch {
    missing.push(`\`${cli}\` is not installed or not on the PATH (npm install -g @playwright/cli)`);
  }
  if (version !== undefined) {
    try {
      // Lists the browsers every Playwright installation on the machine has.
      chromium = /chromium/i.test((await run(cli, ['install-browser', '--list'], { timeout: 30_000 })).stdout);
    } catch {
      chromium = undefined;
    }
    if (chromium === false) missing.push(`${cli} has no Chromium to drive (${cli} install-browser chromium)`);
  }
  if (!skills.includes(BROWSER_SKILL)) missing.push(`pi lists no ${BROWSER_SKILL} skill (\`ralph init\` writes .agents/skills/${BROWSER_SKILL}/)`);

  if (missing.length > 0) return { name, ok: false, detail: `the agent cannot check a screen in a browser: ${missing.join('; ')}`, fatal: false };
  const note = chromium === undefined ? ' (whether it has a Chromium was not checked)' : '';
  return { name, ok: true, detail: `${cli} ${version} driven through the ${BROWSER_SKILL} skill${note}`, fatal: false };
}

function skillsCheck(skills: string[]): CheckResult {
  return {
    name: 'skills',
    ok: skills.length > 0,
    detail:
      skills.length > 0
        ? `${skills.length} available (${skills.slice(0, 4).join(', ')}${skills.length > 4 ? '…' : ''})`
        : 'none found in .agents/skills/ or .pi/skills/ — the agent will run without skills',
    fatal: false,
  };
}
