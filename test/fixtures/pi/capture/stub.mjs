// Scripted OpenAI-compatible /v1/chat/completions stub (streaming). Not a model: replies follow SCRIPT by request count.
import http from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';
const LOG = process.env.STUB_LOG;
let n = 0;
const MODE = process.env.STUB_MODE || 'tool';
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({data:[{id:'stub-model'}]})); }
    const call = ++n;
    const parsed = body ? JSON.parse(body) : {};
    if (LOG) appendFileSync(LOG, JSON.stringify({ call, url: req.url, stream_options: parsed.stream_options, nMessages: parsed.messages?.length, tools: parsed.tools?.map(t=>t.function?.name), lastRole: parsed.messages?.at(-1)?.role, lastContent: JSON.stringify(parsed.messages?.at(-1)?.content).slice(0,300) }) + '\n');
    if (MODE === 'error' ) { res.statusCode = 500; res.setHeader('content-type','application/json'); return res.end(JSON.stringify({error:{message:'stub overloaded', type:'server_error'}})); }
    if (MODE === 'overflow-once' && call === 1) { res.statusCode = 400; res.setHeader('content-type','application/json'); return res.end(JSON.stringify({error:{message:"This model's maximum context length is 4096 tokens. However, you requested 9000 tokens. Please reduce the length of the messages.", type:'invalid_request_error', code:'context_length_exceeded'}})); }
    if (MODE === 'overflow') { res.statusCode = 400; res.setHeader('content-type','application/json'); return res.end(JSON.stringify({error:{message:"This model's maximum context length is 4096 tokens. However, you requested 9000 tokens. Please reduce the length of the messages.", type:'invalid_request_error', code:'context_length_exceeded'}})); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-' + call, object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
    const slow = MODE === 'slow';
    const chunks = [];
    if (call % 2 === 1 && MODE !== 'text' && MODE !== 'overflow-once') {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'I should run echo.' } }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { content: 'Running a command. ' } }] });
      // STUB_TOOL and STUB_ARGS (a JSON object) script another call than the default bash one.
      const tool = process.env.STUB_TOOL || 'bash';
      const args = process.env.STUB_ARGS ? JSON.stringify(JSON.parse(process.env.STUB_ARGS)) : null;
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + call, type: 'function', function: { name: tool, arguments: args ? args.slice(0, 12) : '{"command":' } }] } }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args ? args.slice(12) : MODE==='slow' ? '"sleep 6; echo hi"}' : '"echo hello && echo oops >&2; exit 3"}' } }] } }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      chunks.push({ ...base, choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 12 } } });
    } else {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'All done. ' } }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: { content: '<promise>COMPLETE</promise>' } }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunks.push({ ...base, choices: [], usage: { prompt_tokens: 1400, completion_tokens: 9, total_tokens: 1409 } });
    }
    let i = 0;
    const tick = () => { if (i < chunks.length) { sse(res, chunks[i++]); setTimeout(tick, 20); } else { res.write('data: [DONE]\n\n'); res.end(); } };
    tick();
  });
}).listen(Number(process.env.PORT || 18080), '127.0.0.1', () => console.error('stub up'));
