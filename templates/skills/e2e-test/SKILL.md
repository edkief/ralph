---
name: e2e-test
description: Decide whether a change needs an end-to-end test, and write one that does not flake. Use when a task's acceptance criteria describe a user flow in a browser or across services, or when you are about to write or fix a Playwright (or similar) end-to-end test.
---

# End-to-end tests

An end-to-end test is the slowest and most fragile test there is. Write one only when it checks
something a unit or integration test cannot.

## First, decide

- Does an existing end-to-end test already cover the flow? Extend it instead.
- Would a unit or component test cover the behaviour? Write that instead.
- Is the value in the pieces working together (routing, a real form submit, auth, the API behind
  the page)? Then an end-to-end test earns its place.

Cover the happy path of the flow the spec names, plus the error cases its acceptance criteria name.
Not every permutation.

## Look before you write

Open the page and walk the flow before writing a selector: with your own browser tool if you have
one, or with the `browser-check` skill. Note the roles, labels and visible text of the elements you
will use, and what the page shows while loading, on success and on error. Write the test from what
you saw, not from what the code suggests the page should look like.

## Write it to be stable

Follow the project's existing end-to-end tests first: their folder, helpers, fixtures and page
objects. Otherwise, in Playwright terms:

- **Selectors, in order of preference:** `getByRole` with a name, `getByLabel`, `getByText` for
  static text, `getByTestId` as a last resort. Never CSS classes, ids or DOM structure.
- **Wait for conditions, never for time.** No `waitForTimeout` or sleeps. Assert on what appears:
  `await expect(page.getByRole('alert')).toContainText('Saved')`, `page.waitForURL('**/dashboard')`,
  `page.waitForResponse(...)`.
- **Assert with web-first assertions** (`toBeVisible`, `toHaveText`, `toHaveURL`), which retry,
  rather than reading a value once and comparing it.
- **Own your data.** Each test creates what it needs (through the API or a fixture) with unique
  names, and does not depend on another test or on run order.
- **Reuse login.** Sign in once in a setup step and reuse the stored state, rather than through the
  UI in every test.
- **Mock only what you do not own** (third-party APIs, payment, email), and say so in the test.

## Run it

- Run only the tests you touched first (`npx playwright test path/to/file.spec.ts`, or `-g "name"`),
  headless and in the foreground, then the whole suite before you finish.
- A failure you cannot explain: rerun it with `--trace on` and read the trace, rather than adding
  waits until it passes. A test that passes only sometimes is not done.
- Start any server the test needs yourself if the test config does not, and stop it before you end
  your turn.
- Keep one or two screenshots of the finished flow as evidence in the task's artifacts folder (your
  prompt names it). Test runner output folders (`test-results/`, `playwright-report/`) are scratch:
  never commit them.
