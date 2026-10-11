// Playwright for the agent under pi, through pi's built-in MCP support. Ralph loads it with `--extension` when
// `pi.browser` is "mcp", before its permission gate, so the gate judges every Playwright call like any other.
//
// The server to start comes from RALPH_PLAYWRIGHT_MCP: `{"command": "...", "args": [...]}`, which Ralph sets from
// `pi.playwrightMcp`. A `playwright` server in the user's or the project's mcp.json takes precedence, as pi has it.
//
// No imports: it has to load from wherever Ralph is installed, and pi's own package is not there.

/** The MCP server's name: its tools are `mcp__playwright__<tool>`. */
export const SERVER = 'playwright';

/** The command that proves, in pi's `get_commands`, that the server was registered. */
export const COMMAND = 'ralph-playwright';

/** The server from the environment, or nothing when it is missing or malformed. */
export function serverOf(text) {
  try {
    const parsed = JSON.parse(text ?? '');
    if (!parsed || typeof parsed.command !== 'string' || !parsed.command) return undefined;
    const args = Array.isArray(parsed.args) ? parsed.args.filter((arg) => typeof arg === 'string') : [];
    return { command: parsed.command, args };
  } catch {
    return undefined;
  }
}

/** @param {any} pi pi's extension API */
export default function ralphPlaywright(pi) {
  const server = serverOf(process.env.RALPH_PLAYWRIGHT_MCP);
  if (!server) return;
  pi.registerMcpServer(SERVER, {
    ...server,
    // Declared to the model like a built-in tool: the default would hide the tools behind codemode.
    exposure: 'direct',
    description: 'A real browser: open a page, read it back, interact with it, take a screenshot',
  });

  // Last, so that it is there only if the registration above went through.
  pi.registerCommand(COMMAND, {
    description: 'Playwright, through MCP, for the agent (registered by Ralph)',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Playwright is registered as an MCP server.', 'info');
    },
  });
}
