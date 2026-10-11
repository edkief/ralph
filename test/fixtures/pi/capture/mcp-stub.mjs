// A stdio MCP server with one tool, `say`, which echoes its `text`. For recording an MCP tool call in pi.
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const say = { name: 'say', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // a notification
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  }
  if (method === 'tools/list') return send({ id, result: { tools: [say] } });
  if (method === 'tools/call') return send({ id, result: { content: [{ type: 'text', text: `said: ${params?.arguments?.text ?? ''}` }] } });
  send({ id, error: { code: -32601, message: `no method ${method}` } });
});
