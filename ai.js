// Calls the Anthropic Messages API for TraceFox's agents and maps failures to the
// error codes the TraceFox page already understands.
'use strict';

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Recommended: strong and quick' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable, slower and pricier' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest' },
];
const SYSTEM = 'You are one of the agents inside TraceFox, a desktop app for evidence-based product decisions. Follow the instructions in the user message exactly. Reply with a single JSON object and nothing else: no prose, no code fences.';

function fail(code, message, extra) { return Object.assign({ code, message: message || code }, extra || {}); }

// Pulls the first JSON object out of a model reply, tolerating code fences or stray prose.
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) { /* fall through */ } }
  return undefined;
}

async function mapHttpError(res) {
  let body = {}; let raw = '';
  try { raw = await res.text(); body = JSON.parse(raw); } catch (e) { /* not JSON */ }
  const type = body && body.error && body.error.type;
  const msg = (body && body.error && body.error.message) || raw.slice(0, 300) || ('HTTP ' + res.status);
  if (res.status === 401 || res.status === 403 || type === 'authentication_error' || type === 'permission_error') return fail('invalid_key', msg);
  if (res.status === 429 || type === 'rate_limit_error') return fail('rate_limited', msg);
  if (res.status === 529 || type === 'overloaded_error') return fail('overloaded', msg);
  if (res.status === 400 && /credit balance|billing/i.test(msg)) return fail('billing', msg);
  if (res.status === 400 && /prompt is too long|too many tokens|context/i.test(msg)) return fail('prompt_too_large', msg);
  if (res.status === 404 && /model/i.test(msg)) return fail('error', 'Model not available for this key: ' + msg);
  if (res.status >= 500) return fail('overloaded', msg);
  return fail('error', msg);
}

async function completeJson({ key, model, prompt, signal, fetchImpl }) {
  const f = fetchImpl || fetch;
  if (!key) throw fail('needs_key', 'No API key');
  let res;
  try {
    res = await f(API + '/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
      body: JSON.stringify({ model: model || MODELS[0].id, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content: String(prompt) }] }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('cancelled', 'Stopped');
    throw fail('network', String((e && e.message) || e));
  }
  if (!res.ok) throw await mapHttpError(res);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw fail('refused', 'The model declined');
  const text = (data.content || []).filter(c => c && c.type === 'text').map(c => c.text).join('');
  if (!text.trim()) throw fail('empty_completion', 'Empty reply');
  const json = parseJson(text);
  if (json === undefined || json === null || typeof json !== 'object') throw fail('invalid_json', 'Reply was not JSON');
  return { json, usage: data.usage || null, model: data.model || model };
}

// Checks a key without spending tokens: listing models only needs a valid key.
async function testKey({ key, fetchImpl }) {
  const f = fetchImpl || fetch;
  if (!key) return { ok: false, error: fail('needs_key', 'Enter a key first.') };
  try {
    const res = await f(API + '/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': VERSION } });
    if (res.ok) return { ok: true };
    return { ok: false, error: await mapHttpError(res) };
  } catch (e) {
    return { ok: false, error: fail('network', String((e && e.message) || e)) };
  }
}

module.exports = { MODELS, completeJson, testKey, parseJson, mapHttpError };
