// Unit tests for the Anthropic client: request shape, JSON parsing and error mapping.
const ai = require('../ai');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const reply = text => res(200, { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });

(async () => {
  let seen = null;
  const out = await ai.completeJson({ key: 'sk-ant-test', model: 'claude-sonnet-5-5', prompt: 'Framer agent', fetchImpl: async (url, init) => { seen = { url, init }; return reply('{"beliefs":[]}'); } });
  const body = JSON.parse(seen.init.body);
  ok(seen.url === 'https://api.anthropic.com/v1/messages' && seen.init.headers['x-api-key'] === 'sk-ant-test' && seen.init.headers['anthropic-version'] === '2023-06-01', 'posts to the Messages API with key and version headers');
  ok(body.model === 'claude-sonnet-5-5' && body.messages[0].content === 'Framer agent' && body.max_tokens > 0 && /JSON/.test(body.system), 'sends model, prompt and a JSON-only system prompt');
  ok(Array.isArray(out.json.beliefs), 'parses a plain JSON reply');
  ok((await ai.completeJson({ key: 'k', prompt: 'x', fetchImpl: async () => reply('```json\n{"a":1}\n```') })).json.a === 1, 'parses a fenced JSON reply');
  ok((await ai.completeJson({ key: 'k', prompt: 'x', fetchImpl: async () => reply('Here you go: {"a":2} hope that helps') })).json.a === 2, 'pulls JSON out of stray prose');
  const code = async (f, extra) => { try { await ai.completeJson(Object.assign({ key: 'k', prompt: 'x', fetchImpl: f }, extra || {})); return 'none'; } catch (e) { return e.code; } };
  ok(await code(async () => reply('no json here')) === 'invalid_json', 'non-JSON reply → invalid_json');
  ok(await code(async () => res(200, { stop_reason: 'refusal', content: [] })) === 'refused', 'refusal → refused');
  ok(await code(async () => res(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })) === 'invalid_key', '401 → invalid_key');
  ok(await code(async () => res(429, { error: { type: 'rate_limit_error', message: 'slow down' } })) === 'rate_limited', '429 → rate_limited');
  ok(await code(async () => res(529, { error: { type: 'overloaded_error', message: 'Overloaded' } })) === 'overloaded', '529 → overloaded');
  ok(await code(async () => res(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } })) === 'billing', 'low credit → billing');
  ok(await code(async () => res(400, { error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' } })) === 'prompt_too_large', 'long prompt → prompt_too_large');
  ok(await code(async () => { throw new TypeError('fetch failed'); }) === 'network', 'network failure → network');
  ok(await code(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }) === 'cancelled', 'abort → cancelled');
  ok(await code(async () => reply('{}'), { key: '' }) === 'needs_key', 'no key → needs_key, no request');
  const t1 = await ai.testKey({ key: 'k', fetchImpl: async (url) => { seen = url; return res(200, { data: [] }); } });
  ok(t1.ok && /\/v1\/models/.test(seen), 'key test lists models (no tokens spent)');
  const t2 = await ai.testKey({ key: 'k', fetchImpl: async () => res(401, { error: { type: 'authentication_error', message: 'bad' } }) });
  ok(!t2.ok && t2.error.code === 'invalid_key', 'key test reports a bad key');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
