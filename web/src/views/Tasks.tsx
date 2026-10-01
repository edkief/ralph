import type { StatusView } from '../api';
import { TaskRow, activeTaskId } from './TaskRow';

/** The whole backlog, in the order the loop works through it. */
export function Tasks({ status }: { status: StatusView }) {
  const { tasks } = status;
  const active = activeTaskId(status);

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
        {tasks.items.length === 0 ? (
          <div className="empty small">No tasks in tasks.json</div>
        ) : (
          <ul className="task-list">
            {tasks.items.map((task) => (
              <TaskRow key={task.id} task={task} active={task.id === active} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
