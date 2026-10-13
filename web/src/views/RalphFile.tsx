import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDateTime, formatRunId } from '../format';
import {
  proposedSpecPath,
  readAssessment,
  readDecisions,
  readProposal,
  readSpec,
  specPaths,
  type AssessmentView,
  type DecisionView,
  type ProposalView,
  type RalphFileKind,
  type SpecView,
} from '../ralph-files';
import { href } from '../route';

const KIND_LABEL: Record<RalphFileKind, string> = {
  spec: 'a task spec',
  proposal: 'a split proposal',
  assessment: 'an assessment',
  decisions: 'a decisions log',
};

/** What a file of `kind` reads as, said in a sentence: "a task spec". */
export function kindLabel(kind: RalphFileKind): string {
  return KIND_LABEL[kind];
}

interface Context {
  ralphDir: string;
  /** The listed files, so only links to files that are there are drawn. */
  listed: Set<string>;
}

/**
 * The readable view of a Ralph record, or null when its content does not read
 * as its kind; the Files tab then shows it as it is.
 */
export function ralphFileView(kind: RalphFileKind, content: string, context: Context): ReactNode | null {
  switch (kind) {
    case 'spec': {
      const spec = readSpec(content);
      return spec ? <Spec spec={spec} context={context} /> : null;
    }
    case 'proposal': {
      const proposal = readProposal(content);
      return proposal ? <Proposal proposal={proposal} context={context} /> : null;
    }
    case 'assessment': {
      const assessment = readAssessment(content);
      return assessment ? <Assessment assessment={assessment} context={context} /> : null;
    }
    case 'decisions': {
      const decisions = readDecisions(content);
      return decisions ? <Decisions decisions={decisions} context={context} /> : null;
    }
  }
}

/** Agent-written text; react-markdown never renders raw HTML, so it cannot inject script. */
function Md({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

/** A title: its code spans and emphasis, and no paragraph around it. */
function Inline({ children }: { children: string }) {
  return (
    <Markdown allowedElements={['code', 'strong', 'em', 'del']} unwrapDisallowed>
      {children}
    </Markdown>
  );
}

/** A field the view has no place for: text as Markdown, a list of plain values on a line, anything else as its JSON. */
function FieldValue({ value }: { value: unknown }) {
  if (typeof value === 'string') return <Md>{value}</Md>;
  if (typeof value === 'number' || typeof value === 'boolean') return <>{String(value)}</>;
  if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
    return <>{value.length > 0 ? value.map(String).join(', ') : <span className="muted">none</span>}</>;
  }
  return <pre className="pre">{JSON.stringify(value, null, 2)}</pre>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ralph-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A link to the first of `paths` that is listed, or the children alone. */
function FileLink({ paths, context, children }: { paths: string[]; context: Context; children: ReactNode }) {
  const path = paths.find((candidate) => context.listed.has(candidate));
  return path ? (
    <a href={href('files', path)} title={path}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function TaskLink({ id, context, paths }: { id: string; context: Context; paths?: string[] }) {
  return (
    <FileLink paths={paths ?? specPaths(context.ralphDir, id)} context={context}>
      <code className="ralph-task">{id}</code>
    </FileLink>
  );
}

function Spec({ spec, context }: { spec: SpecView; context: Context }) {
  return (
    <article className="ralph-file document">
      <header className="ralph-head">
        <div className="ralph-tags">
          <code className="ralph-task">{spec.id}</code>
          {spec.category ? <span className="pill">{spec.category}</span> : null}
        </div>
        <h1>{spec.title ? <Inline>{spec.title}</Inline> : <span className="muted">Untitled</span>}</h1>
        {spec.splitFrom ? (
          <p className="muted small">
            Split from <TaskLink id={spec.splitFrom} context={context} />
            {spec.splitDepth !== undefined && spec.splitDepth > 1 ? `, ${spec.splitDepth} splits from the planned task` : ''}
          </p>
        ) : null}
      </header>
      {spec.description ? (
        <Section title="Description">
          <Md>{spec.description}</Md>
        </Section>
      ) : null}
      {spec.steps.length > 0 ? (
        <Section title="Steps">
          <ol className="ralph-list">
            {spec.steps.map((step, index) => (
              <li key={index}>
                <Md>{step}</Md>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {spec.acceptanceCriteria.length > 0 ? (
        <Section title="Acceptance criteria">
          <ul className="ralph-list criteria">
            {spec.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>
                <Md>{criterion}</Md>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {spec.notes ? (
        <Section title="Notes">
          <Md>{spec.notes}</Md>
        </Section>
      ) : null}
      {spec.extra.length > 0 ? (
        <Section title="Other fields">
          <dl className="ralph-fields">
            {spec.extra.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <FieldValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
    </article>
  );
}

function Proposal({ proposal, context }: { proposal: ProposalView; context: Context }) {
  const { task, parent } = proposal;
  const applied = proposal.appliedAt !== undefined;
  const verdict = proposal.splittable
    ? `${applied ? 'Split' : 'Splits'} ${task} into ${proposal.tasks.length} task${proposal.tasks.length === 1 ? '' : 's'}`
    : proposal.retry
      ? `Advises attempting ${task} again as it is`
      : `Advises against splitting ${task}`;
  return (
    <article className="ralph-file document">
      <header className="ralph-head">
        <div className="ralph-tags">
          <TaskLink id={task} context={context} />
          {proposal.splittable ? (
            <span className={applied ? 'pill good' : 'pill warn'}>{applied ? 'applied' : 'proposed'}</span>
          ) : (
            <span className="pill">{proposal.retry ? 'retry' : 'not split'}</span>
          )}
        </div>
        <h1>{verdict}</h1>
        {applied ? <p className="muted small">Applied {formatDateTime(proposal.appliedAt)}</p> : null}
      </header>
      {proposal.reason.trim() ? (
        <Section title="Reason">
          <Md>{proposal.reason}</Md>
        </Section>
      ) : null}
      {proposal.tasks.length > 0 ? (
        <Section title={applied ? 'Split into' : 'Proposed tasks'}>
          <ol className="ralph-list ralph-tasks">
            {proposal.tasks.map((child) => (
              <li key={child.id}>
                <TaskLink
                  id={child.id}
                  context={context}
                  paths={[proposedSpecPath(context.ralphDir, task, child.id), ...specPaths(context.ralphDir, child.id)]}
                />{' '}
                {child.title ? <Inline>{child.title}</Inline> : <span className="muted">untitled</span>}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {parent ? (
        <Section title="The split task">
          <p>{parent.title ? <Inline>{parent.title}</Inline> : <span className="muted">Untitled</span>}</p>
          <ul className="ralph-links">
            {parent.specFilePath ? (
              <li>
                <FileLink paths={[parent.specFilePath]} context={context}>
                  Its spec
                </FileLink>
              </li>
            ) : null}
            {parent.handoffPath ? (
              <li>
                <FileLink paths={[parent.handoffPath]} context={context}>
                  The handoff its last attempt left
                </FileLink>
              </li>
            ) : null}
            {parent.splitFrom ? (
              <li>
                Itself split from <TaskLink id={parent.splitFrom} context={context} />
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}

const VERDICT: Record<string, { label: string; tone: string }> = {
  fits: { label: 'fits', tone: 'pill good' },
  'too-big': { label: 'too big', tone: 'pill warn' },
  unknown: { label: 'no estimate', tone: 'pill' },
};

function Assessment({ assessment, context }: { assessment: AssessmentView; context: Context }) {
  const verdict = VERDICT[assessment.verdict] ?? { label: assessment.verdict, tone: 'pill' };
  const threshold = assessment.thresholdMinutes !== undefined ? `${assessment.thresholdMinutes} min` : null;
  return (
    <article className="ralph-file document">
      <header className="ralph-head">
        <div className="ralph-tags">
          <TaskLink id={assessment.task} context={context} />
          <span className={verdict.tone}>{verdict.label}</span>
        </div>
        <h1>
          {assessment.estimateMinutes !== undefined ? `Estimated at ${assessment.estimateMinutes} min` : 'No estimate'}
          {threshold ? <span className="muted"> against a {threshold} threshold</span> : null}
        </h1>
        {assessment.assessedAt ? <p className="muted small">Assessed {formatDateTime(assessment.assessedAt)}</p> : null}
      </header>
      {assessment.reason.trim() ? (
        <Section title={assessment.estimateMinutes !== undefined ? 'Reason' : 'Why there is none'}>
          <Md>{assessment.reason}</Md>
        </Section>
      ) : null}
    </article>
  );
}

function Decisions({ decisions, context }: { decisions: DecisionView[]; context: Context }) {
  return (
    <article className="ralph-file document">
      <header className="ralph-head">
        <h1>Decisions</h1>
        <p className="muted small">
          What a person or the escalation agent answered or noted: {decisions.length}, newest first. The latest are shown to the
          agent in later prompts.
        </p>
      </header>
      <ol className="ralph-decisions">
        {decisions.map((decision, index) => (
          <li key={index}>
            <div className="ralph-tags">
              <span className="muted small">{formatDateTime(decision.time)}</span>
              {decision.taskId ? <TaskLink id={decision.taskId} context={context} /> : null}
              <span className="pill">{decision.kind}</span>
              {decision.by ? <span className={decision.by === 'agent' ? 'pill warn' : 'pill good'}>by {decision.by === 'agent' ? 'the escalation agent' : 'a person'}</span> : null}
              {decision.runId ? <span className="muted small">run {formatRunId(decision.runId)}</span> : null}
            </div>
            {decision.question ? (
              <div className="ralph-question">
                <Md>{decision.question}</Md>
              </div>
            ) : null}
            <Md>{decision.answer}</Md>
          </li>
        ))}
      </ol>
    </article>
  );
}
