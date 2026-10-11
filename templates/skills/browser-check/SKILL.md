---
name: browser-check
description: Open a page in a real browser, read it back and take a screenshot, with the playwright-cli command. Use it to check a screen you built or to keep a screenshot as evidence, and only when you have no browser tool of your own (no Playwright or browser MCP tools).
---

# Browser checks with playwright-cli

Run `playwright-cli` through `bash`. If `playwright-cli --version` fails, the tool is not installed:
say so in your handoff instead of working around it.

## Steps

1. **Serve the page over http.** `file:` URLs are blocked. Start your dev server, or for static files
   `python3 -m http.server 8765 &` in their folder. You stop it again at the end.
2. **Open it.** `playwright-cli open --browser=chromium http://localhost:8765/`
3. **Read it back.** `playwright-cli snapshot` prints the page as text with a `ref` (`e3`) per element.
   `playwright-cli find "Sign in"` searches the page; `playwright-cli eval "document.title"` runs a
   JavaScript expression. Assert on these, not on a picture.
4. **Interact.** `click e3`, `fill e5 "text"`, `press Enter`, `goto <url>`, then `snapshot` again.
5. **Keep a screenshot** of the finished screen, one or two, not every step:
   `playwright-cli screenshot --filename=.ralph/artifacts/TASK-<id>/<name>.png`
   (the artifacts folder your prompt names; the folder is created for you). Commit it with the task.
6. **Close up.** `playwright-cli close`, and stop the server you started. The browser runs as a
   background process that outlives your commands, so a turn that ends without `close` leaves it behind.

`playwright-cli --help` lists the rest (tabs, network requests, console, storage, device emulation).

## Notes

- `playwright-cli` keeps its own scratch files (snapshots, console logs) in `.playwright-cli/` in the
  folder you run it from. They are not evidence and stay out of git; never `git add` them.
- A screenshot is saved only where `--filename` says. Without it the file lands in `.playwright-cli/`.
- Console errors are listed after each command. A page that loads but logs errors has not passed.
