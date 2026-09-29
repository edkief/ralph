import { describe, expect, it } from 'vitest';
import { parsePromiseTags } from '../src/loop/outcome.js';

describe('parsePromiseTags', () => {
  it('finds a completion tag', () => {
    expect(parsePromiseTags('all done <promise>COMPLETE</promise>').complete).toBe(true);
  });

  it('extracts blocked reasons and decide questions', () => {
    const blocked = parsePromiseTags('<promise>BLOCKED:no network access</promise>');
    expect(blocked.blockedReason).toBe('no network access');

    const decide = parsePromiseTags('<promise>DECIDE:REST or GraphQL?</promise>');
    expect(decide.decideQuestion).toBe('REST or GraphQL?');
  });

  it('collects task ids without duplicates', () => {
    const tags = parsePromiseTags(
      '<promise>TASK-7:DONE</promise> and again <promise>TASK-7:DONE</promise> <promise>TASK-8:DONE</promise>',
    );
    expect(tags.completedTaskIds).toEqual(['TASK-7', 'TASK-8']);
  });

  it('ignores prose that merely mentions the tags', () => {
    const tags = parsePromiseTags('I will output COMPLETE when the backlog is finished.');
    expect(tags.complete).toBe(false);
    expect(tags.completedTaskIds).toEqual([]);
  });
});
