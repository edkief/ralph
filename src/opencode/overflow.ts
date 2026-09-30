/**
 * Provider messages that mean the request no longer fits the model's context
 * window. opencode classifies failures with the same patterns; the error it
 * forwards on the event stream carries only the message, so the loop has to
 * recognise it again.
 */
const PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /is longer than the model'?s context length/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /context ?overflow/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/** Rate limits also say "too many"; they are the provider's problem, not the context's. */
const EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i];

export function isContextOverflow(message: string): boolean {
  return !EXCLUSIONS.some((pattern) => pattern.test(message)) && PATTERNS.some((pattern) => pattern.test(message));
}
