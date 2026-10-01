import type { TaskView } from '../api';
import { href } from '../route';

/** A task as a row of a task list. `active` marks the one the loop is on, or would pick next. */
export function TaskRow({ task, active }: { task: TaskView; active: boolean }) {
  const state = task.passes ? 'done' : active ? 'active' : 'todo';
  return (
    <li className={`task ${state}`}>
      <span className="task-state" aria-label={state === 'done' ? 'passing' : state === 'active' ? 'in progress' : 'to do'}>
        {state === 'done' ? '✓' : state === 'active' ? '▶' : '○'}
      </span>
      <span className="task-id">{task.id}</span>
      <span className="task-title">{task.title || <span className="muted">untitled</span>}</span>
      {task.splitFrom ? (
        <span className="task-split" title={`Split from ${task.splitFrom}, which kept running out of time`}>
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
