import type { TaskView } from '../api';
import { href } from '../route';

/**
 * A task as a row of a task list. `active` marks the one the loop is on, or
 * would pick next; `depth` indents it under the tasks it was split from.
 */
export function TaskRow({ task, active, depth = 0, parentTitle = null }: { task: TaskView; active: boolean; depth?: number; parentTitle?: string | null }) {
  const state = task.passes ? 'done' : active ? 'active' : 'todo';
  return (
    <li className={`task ${state}`} style={depth ? { paddingLeft: `${16 + depth * 18}px` } : undefined}>
      <span className="task-state" aria-label={state === 'done' ? 'passing' : state === 'active' ? 'in progress' : 'to do'}>
        {state === 'done' ? '✓' : state === 'active' ? '▶' : '○'}
      </span>
      <span className="task-id">{task.id}</span>
      <span className="task-title">{task.title || <span className="muted">untitled</span>}</span>
      {task.splitFrom ? (
        <span className="task-split" title={`Split from ${task.splitFrom}${parentTitle ? ` (${parentTitle})` : ''}, which was too big for one iteration`}>
          from {task.splitFrom}
        </span>
      ) : null}
      {task.category ? <span className="task-category">{task.category}</span> : null}
      {task.specFilePath ? (
        <a className="task-spec" href={href('files', task.specFilePath)} title="Open the spec">
          spec
        </a>
      ) : null}
    </li>
  );
}

/** The task the loop is on while it runs, otherwise the one it would pick next. */
export function activeTaskId(status: { tasks: { next: string | null }; run: { live: boolean; taskId: string | null } | null }): string | null {
  return status.run?.live ? status.run.taskId : status.tasks.next;
}
