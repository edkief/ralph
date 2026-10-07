import { sleep } from '../opencode/server.js';
import { DONE_COMMAND } from './interview.js';
import { planStopRequested, readPlanReply, RecordingIO, type PlanRecorder } from './record.js';

const POLL_MS = 500;

/**
 * The interview held through files, for an owner in the web UI: what is said
 * goes to the session's record, a question waits for `reply.json` to answer
 * it by number, and `stop.json` ends it. Nothing here needs the owner's
 * process, so they may be in another container that shares the folder.
 */
export class FileInterviewIO extends RecordingIO {
  /** The description, given with the request: the answer to the first question. */
  private seed: string | undefined;
  private readonly watch: NodeJS.Timeout;

  constructor(
    recorder: PlanRecorder,
    options: {
      /** Aborted when the interview is over for any reason; a question then gets no answer. */
      signal: AbortSignal;
      /** Called once when the owner asks to stop. */
      onStop: () => void;
      seed?: string;
      pollMs?: number;
    },
  ) {
    const pollMs = options.pollMs ?? POLL_MS;
    const { ralphRoot, id } = recorder;
    super(
      {
        say: () => {},
        status: () => {},
        note: () => {},
        ask: async () => {
          const seq = recorder.current.seq;
          for (;;) {
            if (options.signal.aborted) return null;
            const reply = readPlanReply(ralphRoot, id);
            if (reply?.seq === seq) return reply.done ? DONE_COMMAND : (reply.text ?? '');
            await sleep(pollMs, options.signal);
          }
        },
      },
      recorder,
    );
    this.seed = options.seed?.trim() ? options.seed : undefined;
    // Watched all along, not only while asking: a stop also interrupts the agent at work.
    this.watch = setInterval(() => {
      if (!planStopRequested(ralphRoot, id)) return;
      clearInterval(this.watch);
      options.onStop();
    }, pollMs);
    this.watch.unref();
  }

  override async ask(prompt: string): Promise<string | null> {
    if (this.seed === undefined) return super.ask(prompt);
    const seed = this.seed;
    this.seed = undefined;
    this.recorder.line('owner', seed);
    return seed;
  }

  close(): void {
    clearInterval(this.watch);
  }
}
