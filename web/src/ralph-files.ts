/**
 * Ralph's own records in the Ralph folder, recognised by where they live and
 * read into what the Files tab shows of them. Each reader returns null for a
 * file that does not read as its kind (hand-edited, half-written), and the tab
 * shows that file as it is.
 */

/** As `TASK_ID` in src/tasks/store.ts; keep the two in step. */
const TASK_ID = /^TASK-[A-Za-z0-9._-]+$/;

export type RalphFileKind = 'spec' | 'proposal' | 'assessment' | 'decisions';

/** `ralphDir` as the start of the listed paths in it: `.ralph/`. */
function prefixOf(ralphDir: string): string {
  const root = ralphDir.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return root && root !== '.' ? `${root}/` : '';
}

/** Where a task's spec may be, most likely first: in the backlog, or archived once the task was split. */
export function specPaths(ralphDir: string, taskId: string): string[] {
  const prefix = prefixOf(ralphDir);
  return [`${prefix}tasks/${taskId}.json`, `${prefix}split/${taskId}/${taskId}.json`];
}

/** Where the split of `taskId` proposes the spec of `childId`, until it is applied. */
export function proposedSpecPath(ralphDir: string, taskId: string, childId: string): string {
  return `${prefixOf(ralphDir)}split/${taskId}/${childId}.json`;
}

/** What kind of Ralph record `path` (relative to the project root) is, if any. */
export function recognise(path: string, ralphDir: string): RalphFileKind | null {
  const prefix = prefixOf(ralphDir);
  if (!path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('/');
  const name = parts[parts.length - 1] ?? '';
  const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';

  if (parts.length === 1) return name === 'decisions.jsonl' ? 'decisions' : null;
  if (parts.length === 2 && parts[0] === 'tasks') return TASK_ID.test(id) ? 'spec' : null;
  if (parts.length === 2 && parts[0] === 'assess') return TASK_ID.test(id) ? 'assessment' : null;
  if (parts.length === 3 && parts[0] === 'split' && TASK_ID.test(parts[1] ?? '')) {
    if (name === 'proposal.json') return 'proposal';
    // The split task's archived spec, or one the proposal would make of it.
    return TASK_ID.test(id) ? 'spec' : null;
  }
  return null;
}

export interface SpecView {
  id: string;
  title: string;
  category?: string;
  description?: string;
  steps: string[];
  acceptanceCriteria: string[];
  notes?: string;
  splitFrom?: string;
  splitDepth?: number;
  /** Fields the view has no place for, in the file's order, so nothing in it is hidden. */
  extra: Array<[string, unknown]>;
}

export interface ProposalView {
  task: string;
  splittable: boolean;
  /** Not splittable, but worth attempting again as it is. */
  retry: boolean;
  reason: string;
  tasks: Array<{ id: string; title: string }>;
  appliedAt?: string;
  /** What the split task was, kept once the split is applied. */
  parent?: { title?: string; specFilePath?: string; handoffPath?: string; splitFrom?: string };
}

export interface AssessmentView {
  task: string;
  verdict: string;
  estimateMinutes?: number;
  thresholdMinutes?: number;
  reason: string;
  assessedAt?: string;
}

export interface DecisionView {
  time: string;
  runId: string;
  taskId: string | null;
  kind: string;
  question?: string;
  answer: string;
  by?: 'person' | 'agent';
}

const SPEC_FIELDS = new Set(['id', 'title', 'category', 'description', 'steps', 'acceptanceCriteria', 'notes', 'splitFrom', 'splitDepth']);

type Fields = Record<string, unknown>;

function parseObject(text: string): Fields | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A list of strings; anything else in it shown as its JSON. */
function lines(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
}

export function readSpec(content: string): SpecView | null {
  const spec = parseObject(content);
  if (!spec || typeof spec['id'] !== 'string') return null;
  const view: SpecView = {
    id: spec['id'],
    title: typeof spec['title'] === 'string' ? spec['title'] : '',
    steps: lines(spec['steps']),
    acceptanceCriteria: lines(spec['acceptanceCriteria']),
    extra: Object.entries(spec).filter(([key]) => !SPEC_FIELDS.has(key)),
  };
  for (const key of ['category', 'description', 'notes', 'splitFrom'] as const) {
    const value = text(spec[key]);
    if (value) view[key] = value;
  }
  const splitDepth = number(spec['splitDepth']);
  if (splitDepth !== undefined) view.splitDepth = splitDepth;
  return view;
}

export function readProposal(content: string): ProposalView | null {
  const proposal = parseObject(content);
  if (!proposal || typeof proposal['task'] !== 'string' || typeof proposal['splittable'] !== 'boolean') return null;
  const tasks = Array.isArray(proposal['tasks']) ? proposal['tasks'] : [];
  const parent = proposal['parent'];
  const parentFields = parent !== null && typeof parent === 'object' && !Array.isArray(parent) ? (parent as Fields) : undefined;
  const view: ProposalView = {
    task: proposal['task'],
    splittable: proposal['splittable'],
    retry: proposal['retry'] === true,
    reason: typeof proposal['reason'] === 'string' ? proposal['reason'] : '',
    tasks: tasks.flatMap((task) => {
      const fields = task !== null && typeof task === 'object' ? (task as Fields) : {};
      return typeof fields['id'] === 'string' ? [{ id: fields['id'], title: typeof fields['title'] === 'string' ? fields['title'] : '' }] : [];
    }),
  };
  const appliedAt = text(proposal['appliedAt']);
  if (appliedAt) view.appliedAt = appliedAt;
  if (parentFields) {
    view.parent = {};
    for (const key of ['title', 'specFilePath', 'handoffPath', 'splitFrom'] as const) {
      const value = text(parentFields[key]);
      if (value) view.parent[key] = value;
    }
  }
  return view;
}

export function readAssessment(content: string): AssessmentView | null {
  const assessment = parseObject(content);
  if (!assessment || typeof assessment['task'] !== 'string' || typeof assessment['verdict'] !== 'string') return null;
  const view: AssessmentView = {
    task: assessment['task'],
    verdict: assessment['verdict'],
    reason: typeof assessment['reason'] === 'string' ? assessment['reason'] : '',
  };
  const estimate = number(assessment['estimateMinutes']);
  const threshold = number(assessment['thresholdMinutes']);
  const assessedAt = text(assessment['assessedAt']);
  if (estimate !== undefined) view.estimateMinutes = estimate;
  if (threshold !== undefined) view.thresholdMinutes = threshold;
  if (assessedAt) view.assessedAt = assessedAt;
  return view;
}

/**
 * The decisions, newest first. Lines that do not read as one are skipped, as
 * the loop skips them; null when none does.
 */
export function readDecisions(content: string): DecisionView[] | null {
  const decisions: DecisionView[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const value = parseObject(line);
    const answer = value ? text(value['answer']) : undefined;
    if (!value || !answer) continue;
    const by = value['by'];
    decisions.push({
      time: typeof value['time'] === 'string' ? value['time'] : '',
      runId: typeof value['runId'] === 'string' ? value['runId'] : '',
      taskId: typeof value['taskId'] === 'string' ? value['taskId'] : null,
      kind: typeof value['kind'] === 'string' ? value['kind'] : 'note',
      ...(typeof value['question'] === 'string' ? { question: value['question'] } : {}),
      answer,
      ...(by === 'person' || by === 'agent' ? { by } : {}),
    });
  }
  return decisions.length > 0 ? decisions.reverse() : null;
}
