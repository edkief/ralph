import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExitCode } from '../exit.js';
import { detectPacks, installCommands, PACKS, resolvePacks, UnknownPackError, type Pack } from './packs.js';

const execFileAsync = promisify(execFile);

/** Runs one command in the project; resolves with its output, or rejects with an error carrying it. */
export type CommandRunner = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

const runCommand: CommandRunner = (argv, cwd) =>
  execFileAsync(argv[0]!, argv.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } });

export interface InstallResult {
  ok: boolean;
  /** One line per command, and the CLI's output for any that failed. */
  report: string[];
}

/**
 * Install packs with the `skills` CLI, one command per repository. Every
 * command runs even when one fails, so one unreachable repository does not
 * hold up the rest.
 */
export async function installPacks(
  projectRoot: string,
  packs: Pack[],
  run: CommandRunner = runCommand,
): Promise<InstallResult> {
  const report: string[] = [];
  let ok = true;
  for (const argv of installCommands(packs)) {
    const shown = argv.join(' ');
    try {
      await run(argv, projectRoot);
      report.push(`  ✓ ${shown}`);
    } catch (cause) {
      ok = false;
      const { stdout, stderr, message } = cause as { stdout?: string; stderr?: string; message: string };
      const output = [stderr, stdout].filter((text) => text?.trim()).join('\n').trim() || message;
      report.push(`  ✗ ${shown}`, ...output.split('\n').map((line) => `      ${line}`));
    }
  }
  return { ok, report };
}

/** `ralph skills`: the packs, those the project suggests, and how to install them. */
export function describePacks(projectRoot: string): string {
  const detected = new Set(detectPacks(projectRoot).map((pack) => pack.name));
  const width = Math.max(...PACKS.map((pack) => pack.name.length));
  const lines = [
    'Skill packs: curated upstream skills, installed with the `skills` CLI to .agents/skills/',
    '',
    ...PACKS.flatMap((pack) => [
      `  ${pack.name.padEnd(width)}  ${pack.description}${detected.has(pack.name) ? '  [detected]' : ''}`,
      ...pack.sources.map((source) => `  ${''.padEnd(width)}    ${source.repo}: ${source.skills.join(', ')}`),
    ]),
    '',
  ];
  if (detected.size > 0) {
    const packs = [...detected];
    lines.push(
      `This project suggests: ${packs.join(', ')}. Install with \`ralph skills add ${packs.join(' ')}\`, which runs:`,
      ...installCommands(resolvePacks(packs)).map((argv) => `  ${argv.join(' ')}`),
    );
  } else {
    lines.push('Nothing in this project suggests a pack. Install one with `ralph skills add <pack>`.');
  }
  lines.push(
    '',
    'Commit .agents/skills/ and skills-lock.json to share them; `npx skills experimental_install` restores them.',
    'For other skills, updates and removal, use `npx skills` (find, add, update, remove).',
  );
  return lines.join('\n');
}

/** `ralph skills [add <pack...>]`. */
export async function runSkills(args: {
  projectRoot: string;
  /** Everything after `skills` on the command line. */
  positionals: string[];
  run?: CommandRunner;
}): Promise<number> {
  const [action, ...names] = args.positionals;
  if (action === undefined || action === 'list') {
    process.stdout.write(`${describePacks(args.projectRoot)}\n`);
    return 0;
  }
  if (action !== 'add') {
    process.stderr.write(`Unknown skills action: ${action}. Use \`ralph skills\` or \`ralph skills add <pack...>\`.\n`);
    return ExitCode.ConfigError;
  }
  if (names.length === 0) {
    process.stderr.write('Name the packs to install, e.g. `ralph skills add react postgres`. `ralph skills` lists them.\n');
    return ExitCode.ConfigError;
  }

  let packs: Pack[];
  try {
    packs = resolvePacks(names.flatMap((name) => name.split(',')));
  } catch (cause) {
    if (!(cause instanceof UnknownPackError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return ExitCode.ConfigError;
  }
  process.stdout.write(`Installing ${packs.map((pack) => pack.name).join(', ')}…\n`);
  const result = await installPacks(args.projectRoot, packs, args.run);
  (result.ok ? process.stdout : process.stderr).write(`${result.report.join('\n')}\n`);
  return result.ok ? 0 : ExitCode.ConfigError;
}
