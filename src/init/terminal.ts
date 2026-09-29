import { createInterface, type Interface } from 'node:readline';
import { ConsoleReporter } from '../report/console.js';
import type { InterviewIO } from './interview.js';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * The interview in a terminal. A message ends with an empty line, so pasted
 * multi-line answers arrive whole; a line starting with `/` is a command and
 * is sent at once. Ctrl-C calls `onInterrupt` and Ctrl-D quits.
 */
export class TerminalIO implements InterviewIO {
  private readonly rl: Interface;
  private readonly lines: AsyncIterator<string>;
  private readonly reporter: ConsoleReporter;

  constructor(
    private readonly output: NodeJS.WriteStream,
    input: NodeJS.ReadableStream,
    onInterrupt: () => void,
  ) {
    this.rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });
    this.rl.on('SIGINT', () => {
      onInterrupt();
      this.rl.close();
    });
    this.lines = this.rl[Symbol.asyncIterator]();
    this.reporter = new ConsoleReporter(output);
  }

  say(text: string): void {
    this.reporter.clearStatus();
    this.output.write(`\n${this.paint('agent ›', CYAN + BOLD)} ${text}\n`);
  }

  status(text: string): void {
    this.reporter.status(text);
  }

  note(text: string): void {
    this.reporter.clearStatus();
    this.output.write(`\n${this.paint(text, YELLOW)}\n`);
  }

  async ask(prompt: string): Promise<string | null> {
    this.reporter.clearStatus();
    this.output.write('\n');
    const collected: string[] = [];
    for (;;) {
      this.rl.setPrompt(collected.length === 0 ? `${this.paint(`${prompt} ›`, BOLD)} ` : '  ');
      this.rl.prompt();
      const next = await this.lines.next().catch(() => ({ done: true as const, value: undefined }));
      if (next.done) return collected.length > 0 ? collected.join('\n') : null;

      const line = next.value;
      if (collected.length === 0 && line.trim().startsWith('/')) return line.trim();
      if (line.trim() === '') {
        if (collected.length > 0) return collected.join('\n');
        continue;
      }
      collected.push(line);
    }
  }

  close(): void {
    this.reporter.clearStatus();
    this.rl.close();
  }

  private paint(text: string, color: string): string {
    return this.output.isTTY ? `${color}${text}${RESET}` : text;
  }
}
