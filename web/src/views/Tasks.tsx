import type { ReactElement } from 'react';
import type { SplitTaskView, StatusView } from '../api';
import { href } from '../route';
import { TaskRow, activeTaskId } from './TaskRow';

/**
 * The whole backlog, in the order the loop works through it. A task that was
 * split is gone from tasks.json; it heads the tasks it was split into, so its
 * scope stays in view, and is not counted.
 */
export function Tasks({ status }: { status: StatusView }) {
  const { tasks } = status;
  const active = activeTaskId(status);
  const splits = new Map((tasks.splits ?? []).map((split) => [split.id, split]));
  const parentOf = new Map<string, string>();
  for (const split of splits.values()) for (const child of split.children) if (!parentOf.has(child)) parentOf.set(child, split.id);
  for (const task of tasks.items) if (task.splitFrom) parentOf.set(task.id, task.splitFrom);

  /** The split tasks `id` came from, outermost first. */
  const ancestors = (id: string): SplitTaskView[] => {
    const chain: SplitTaskView[] = [];
    const seen = new Set([id]);
    for (let parent = parentOf.get(id); parent && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      const split = splits.get(parent);
      if (!split) break;
      chain.unshift(split);
    }
    return chain;
  };

  const shown = new Set<string>();
  const rows: ReactElement[] = [];
  for (const task of tasks.items) {
    const chain = ancestors(task.id);
    chain.forEach((split, depth) => {
      if (shown.has(split.id)) return;
      shown.add(split.id);
      rows.push(<SplitRow key={`split-${split.id}`} split={split} depth={depth} />);
    });
    rows.push(
      <TaskRow key={task.id} task={task} active={task.id === active} depth={chain.length} parentTitle={chain[chain.length - 1]?.title ?? null} />,
    );
  }

  return (
    <div className="stack">
      {tasks.error ? <div className="banner bad">{tasks.error}</div> : null}
      <section className="panel">
        <h2 className="panel-title">
          Tasks
          <span className="panel-subtitle">
            {tasks.passed} of {tasks.total} passing
          </span>
        </h2>
        {tasks.items.length === 0 ? <div className="empty small">No tasks in tasks.json</div> : <ul className="task-list">{rows}</ul>}
      </section>
    </div>
  );
}

/** A task that was split, over the tasks it was split into. */
function SplitRow({ split, depth }: { split: SplitTaskView; depth: number }) {
  return (
    <li className="task split-parent" style={depth ? { paddingLeft: `${16 + depth * 18}px` } : undefined}>
      <span className="task-state" aria-label="split">
        ◇
      </span>
      <span className="task-id">{split.id}</span>
      <span className="task-title">{split.title || <span className="muted">untitled</span>}</span>
      <span className="task-split">split into {split.children.length}</span>
      {split.specFilePath ? (
        <a className="task-spec" href={href('files', split.specFilePath)} title="Open the spec it had before the split: its whole scope">
          spec
        </a>
      ) : null}
    </li>
  );
}
