import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { makeOpenAiProvider } from '../http/openai-provider.mjs';
import { canonicalBytes, digestBytes } from '../gate/review-receipt.mjs';
import { redactCredential } from '../secret.mjs';
import { requireValue, contentDigest } from './schema.mjs';
import { LIMITS, CANDIDATE, SYSTEM, EXTRA_BODY, validatePacket, requestBody, extractModelResult, sanitizeEnvelope,
  envelopeObservation, loadPrepared, currentReservation, validateQualification, exists, publish, terminalWitness } from './audit.mjs';

export function normalizeUsage(value) {
  const raw = value?.usage; const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
  const input = count(raw?.prompt_tokens); const output = count(raw?.completion_tokens);
  const cached = count(raw?.prompt_tokens_details?.cached_tokens) ?? count(raw?.prompt_cache_hit_tokens);
  return { input, output, cacheRead: input !== null && cached !== null && cached <= input ? cached : null };
}
export async function fixedExchange({ packet, request, env = {}, fetchImpl = globalThis.fetch, httpTimeoutMs = LIMITS.httpTimeoutMs }) {
  validatePacket(packet); requireValue(request === JSON.stringify(requestBody(packet)), 'request_mismatch');
  requireValue(Buffer.byteLength(request) <= LIMITS.requestBytes, 'profile_input_limit');
  requireValue(Number.isInteger(httpTimeoutMs) && httpTimeoutMs > 0 && httpTimeoutMs <= LIMITS.httpTimeoutMs, 'invalid_timeout');
  const started = Date.now(); const credential = String(env.DEEPSEEK_API_KEY ?? '').trim();
  const observed = { envelope: null, rawText: null, rawDigest: null, bytes: 0, status: null, requests: 0, code: null };
  let payload = null; let failure = null;
  const assert = (ok, code) => { if (!ok) observed.code = code; requireValue(ok, code); };
  const provider = makeOpenAiProvider({ name: 'direction-audit', keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlDefault: CANDIDATE.endpoint.replace('/chat/completions', ''), tokenParamOverrideEnv: null,
    buildExtraBody: () => EXTRA_BODY, normalizeUsage,
    extractText: value => {
      observed.envelope = value;
      assert(Array.isArray(value?.choices) && value.choices.length === 1, 'invalid_choices');
      const choice = value.choices[0];
      assert(choice?.message && typeof choice.message.content === 'string', 'invalid_content');
      assert(envelopeObservation(value).toolCallsPresent === false, 'unexpected_tool_call');
      assert(choice.finish_reason === 'stop', 'incomplete_finish'); assert(value.model === CANDIDATE.model, 'identity_mismatch');
      return choice.message.content;
    } });
  try {
    const returned = await provider.complete({ system: SYSTEM, user: requestBody(packet).messages[1].content,
      model: CANDIDATE.model, maxTokens: LIMITS.outputTokens, env: { DEEPSEEK_API_KEY: credential }, httpTimeoutMs,
      fetchImpl: async (url, options) => {
        assert(url === CANDIDATE.endpoint && options.method === 'POST' && options.body === request, 'wire_mismatch');
        assert(observed.requests === 0 && Buffer.byteLength(options.body) <= LIMITS.requestBytes, 'request_limit');
        assert(!credential || !options.body.includes(credential), 'sensitive_request'); observed.requests++;
        const response = await fetchImpl(url, { ...options, redirect: 'error' }); observed.status = response.status;
        assert(!response.redirected && (!response.url || response.url === CANDIDATE.endpoint), 'unexpected_redirect');
        if (!response.ok) await response.body?.cancel();
        return { ok: response.ok, status: response.status, json: async () => {
          assert(response.body && typeof response.body.getReader === 'function', 'missing_response_body');
          const reader = response.body.getReader(); const chunks = [];
          const abort = () => { void reader.cancel().catch(() => {}); };
          options.signal.addEventListener('abort', abort, { once: true });
          try {
            while (true) {
              options.signal.throwIfAborted(); const { done, value } = await reader.read(); options.signal.throwIfAborted();
              if (done) break;
              observed.bytes += value.byteLength;
              if (observed.bytes > LIMITS.responseBytes) { observed.code = 'response_limit'; await reader.cancel(); requireValue(false, 'response_limit'); }
              chunks.push(Buffer.from(value));
            }
            const bytes = Buffer.concat(chunks); observed.rawDigest = digestBytes(bytes);
            observed.rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return JSON.parse(observed.rawText);
          } finally { options.signal.removeEventListener('abort', abort); reader.releaseLock(); }
        } };
      } });
    payload = extractModelResult(returned.text, packet, credential);
  } catch (error) { failure = observed.code || error.code || 'invalid_response'; }
  let response = null;
  if (observed.rawDigest !== null) {
    let envelope;
    try { envelope = sanitizeEnvelope(observed.envelope, credential, payload === null ? null : canonicalBytes(payload)); }
    catch { envelope = null; payload = null; failure ||= 'nesting_limit'; }
    const unparsedText = observed.envelope === null && observed.rawText !== null ? redactCredential(observed.rawText, credential).text : null;
    response = { version: 1, wireDigest: observed.rawDigest, responseBytes: observed.bytes, httpStatus: observed.status,
      envelope, unparsedText, redacted: JSON.stringify(envelope) !== JSON.stringify(observed.envelope), extraction: payload === null ? 'invalid' : 'model-result' };
  }
  const classification = !failure ? 'completed' : failure === 'timeout' ? 'timeout'
    : ['no_key', 'auth', 'rate_limit', 'model_unavailable', 'transport', 'upstream'].includes(failure) ? 'unavailable' : 'invalid';
  const ended = Date.now(); const envelope = envelopeObservation(response?.envelope);
  const observation = { version: 1, packetDigest: contentDigest(packet), requestDigest: digestBytes(request), profileDigest: packet.profileDigest,
    startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), elapsedMs: ended - started,
    requestedModel: CANDIDATE.model, observedModel: envelope.model, identitySource: CANDIDATE.identitySource,
    identityLimit: 'Provider alias, not weight attestation or cache erasure.', httpStatus: observed.status,
    finishReason: envelope.finishReason, toolCallsPresent: envelope.toolCallsPresent,
    exitCode: { completed: 0, invalid: 1, unavailable: 2, timeout: 3 }[classification], classification,
    reason: failure || 'completed', usage: normalizeUsage(observed.envelope), response: null, wireResponseDigest: response?.wireDigest || null };
  return { observation, payload, response, requests: observed.requests };
}

export async function recordExchange({ cwd = process.cwd(), runId, issueId, auditId, env = {}, fetchImpl = globalThis.fetch,
  httpTimeoutMs = LIMITS.httpTimeoutMs }) {
  const where = { cwd, runId, issueId, auditId }; const input = loadPrepared(where);
  currentReservation(where, input);
  for (const name of ['dispatch.json', 'response.json', 'result.json', 'terminal-witness.txt']) {
    requireValue(!exists(join(input.directory, name)), 'output_exists');
  }
  publish(input.directory, 'dispatch.json', { version: 1, auditId, packetDigest: contentDigest(input.packet),
    requestDigest: input.preparation.requestDigest, profileDigest: input.packet.profileDigest, startedAt: new Date().toISOString() });
  const exchange = await fixedExchange({ packet: input.packet, request: input.request, env, fetchImpl, httpTimeoutMs });
  if (exchange.response) exchange.observation.response = publish(input.root, `${input.path}/response.json`, exchange.response);
  const result = { version: 1, packetDigest: contentDigest(input.packet), observation: exchange.observation, payload: exchange.payload };
  const reference = publish(input.root, `${input.path}/result.json`, result);
  publish(input.directory, 'terminal-witness.txt', terminalWitness(auditId, exchange.observation, exchange.requests ? 'started' : 'not-started'), true);
  let current = true; let freshnessReason = null;
  try { currentReservation(where, input, { terminal: true }); } catch (error) { current = false; freshnessReason = error.code || 'state_unavailable'; }
  return { version: 1, exitCode: result.observation.exitCode, classification: result.observation.classification,
    reason: result.observation.reason, current, freshnessReason, result: reference, requests: exchange.requests,
    qualification: 'NOT_QUALIFIED_BY_HELPER' };
}
export async function dispatchAudit({ cwd = process.cwd(), runId, issueId, auditId, env = {} }) {
  validateQualification();
  return recordExchange({ cwd, runId, issueId, auditId, env });
}
