import { readFileSync } from 'node:fs';
const l = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const skip = new Set(['message_update']);
for (const e of l) {
  const x = e.line;
  if (e.dir === 'err') { console.log(e.t, 'ERR', e.text.slice(0, 300)); continue; }
  if (e.dir === 'exit') { console.log(e.t, 'EXIT', e.code, e.sig); continue; }
  if (x.type === 'message_update') { const a = x.assistantMessageEvent.type; if (!/delta/.test(a)) console.log(e.t, e.dir, 'mu:' + a); continue; }
  let extra = '';
  if (x.type === 'message_end' || x.type === 'message_start') extra = x.message.role + (x.message.stopReason ? ' stop=' + x.message.stopReason : '') + (x.message.errorMessage ? ' err=' + x.message.errorMessage.slice(0, 200) : '') + (x.message.role==='user'? ' '+JSON.stringify(x.message.content).slice(0,80):'');
  else if (x.type === 'agent_end') extra = x.messages.map(m => m.role + (m.stopReason ? ':' + m.stopReason : '')+ (m.errorMessage?'!'+m.errorMessage.slice(0,120):'')).join(',');
  else if (x.type === 'turn_end') extra = x.message.stopReason;
  else if (x.type === 'response') extra = x.command + ' ok=' + x.success + (x.error ? ' error=' + x.error : '') + (x.command==='get_state'?' streaming='+x.data.isStreaming:'');
  else if (x.type.startsWith('tool_exec')) extra = x.toolName + (x.isError !== undefined ? ' isError=' + x.isError : '');
  else extra = JSON.stringify(x).slice(0, 300);
  console.log(e.t, e.dir, x.type, extra);
}
