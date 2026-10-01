import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What a person told Ralph: the answer to an agent's question, or a note left
 * when resuming a run. Kept in `decisions.jsonl` in the Ralph folder and shown
 * to the agent in later prompts, so an answer outlives the run it was given in.
 */
export interface Decision {
  time: string;
  runId: string;
  taskId: string | null;
  /** The kind of request it answered. */
  kind: string;
  /** What the agent asked, or what had stopped the run. */
  question?: string;
  answer: string;
}

export const decisionsPath = (ralphRoot: string) => resolve(ralphRoot, 'decisions.jsonl');

export function recordDecision(ralphRoot: string, decision: Decision): void {
  mkdirSync(ralphRoot, { recursive: true });
  appendFileSync(decisionsPath(ralphRoot), `${JSON.stringify(decision)}\n`);
}

/** The latest `count` decisions, oldest first. Lines a person broke by hand are skipped. */
export function recentDecisions(ralphRoot: string, count: number): Decision[] {
  let text: string;
  try {
    text = readFileSync(decisionsPath(ralphRoot), 'utf8');
  } catch {
    return [];
  }
  const decisions: Decision[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<Decision>;
      if (typeof value.answer === 'string' && value.answer.trim()) {
        decisions.push({
          time: String(value.time ?? ''),
          runId: String(value.runId ?? ''),
          taskId: typeof value.taskId === 'string' ? value.taskId : null,
          kind: String(value.kind ?? 'note'),
          ...(typeof value.question === 'string' ? { question: value.question } : {}),
          answer: value.answer,
        });
      }
    } catch {
      // Skip it.
    }
  }
  return decisions.slice(-count);
}
