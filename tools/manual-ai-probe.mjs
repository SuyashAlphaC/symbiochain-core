// Explicit one-shot diagnostic. Never imported by the server, workers or treasury.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'dotenv';

const dir = '.data/manual-ai-probe/';
const origin = 'https://cloud-api.near.ai';
const model = 'z-ai/glm-5.3-flash';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const save = (name, value, once = false) => writeFile(dir + name,
  JSON.stringify(value, null, 2) + '\n', { mode: 0o600, ...(once ? { flag: 'wx' } : {}) });
let paidPostStarted = false;
try {
  assert.equal(process.argv[2], '--execute-unverified-once', 'EXPLICIT_ONE_SHOT_FLAG_REQUIRED');
  const env = parse(await readFile('.env'));
  assert.ok(env.NEAR_AI_API_KEY, 'API_KEY_REQUIRED');
  assert.ok(env.NEAR_AI_ORG_ID, 'CONFIGURED_ORG_REQUIRED');
  assert.equal(env.EXECUTION_ENABLED, 'false', 'AUTOMATED_EXECUTION_MUST_STAY_DISARMED');
  const headers = { authorization: 'Bearer ' + env.NEAR_AI_API_KEY, 'content-type': 'application/json' };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const catalogResponse = await fetch(origin + '/v1/models', {
    headers, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  assert.equal(catalogResponse.status, 200, 'CATALOG_UNAVAILABLE');
  const catalog = await catalogResponse.json();
  const selected = catalog.data.filter((m) => m.id === model);
  assert.equal(selected.length, 1, 'MODEL_NOT_UNIQUE');
  const m = selected[0];
  assert.equal(m.owned_by, 'nearai'); assert.equal(m.is_ready, true);
  assert.ok(Number.isSafeInteger(m.context_length) && m.context_length <= 1048576);
  // Validate per-token nano-USD prices; reserve the entire advertised context.
  const price = (s) => {
    assert.match(s, /^(0|[1-9]\d*)(\.\d{1,9})?$/);
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 1000000000n + BigInt(f.padEnd(9, '0'));
  };
  assert.ok(price(m.pricing.prompt) <= 80n && price(m.pricing.completion) <= 500n);
  assert.equal(price(m.pricing.request), 0n);
  const maxTokens = 64, thinkingTokens = 16;
  const boundMicros = (BigInt(m.context_length) * price(m.pricing.prompt) +
    BigInt(maxTokens + thinkingTokens) * price(m.pricing.completion) + 999n) / 1000n;
  assert.ok(boundMicros <= 100000n && boundMicros <= BigInt(env.AI_MAX_REQUEST_USD_MICROS));
  const request = {
    model, stream: false, temperature: 0, max_tokens: maxTokens,
    thinking_token_budget: thinkingTokens, reasoning_effort: 'low',
    messages: [{ role: 'user', content: 'Reply with exactly NEAR_AI_OK. This is a connectivity test, not a financial decision.' }],
  };
  const requestText = JSON.stringify(request);
  const startedAt = new Date().toISOString();
  // Exclusive write precedes the only inference POST. Unknown outcomes cannot retry.
  await save('attempt.json', {
    startedAt, state: 'MAY_HAVE_BEEN_ACCEPTED_DO_NOT_REPEAT', request,
    keyFingerprint: hash(env.NEAR_AI_API_KEY), worstCaseUsdMicros: boundMicros.toString(),
    requestCeilingUsdMicros: '100000', keyOrgBindingNotIndependentlyVerified: true,
  }, true);
  paidPostStarted = true;
  const response = await fetch(origin + '/v1/chat/completions', {
    method: 'POST', headers: { ...headers, 'x-request-id': randomUUID() },
    body: requestText, redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  const raw = await response.text();
  await writeFile(dir + 'response.json', raw, { mode: 0o600, flag: 'wx' });
  const inferenceId = response.headers.get('inference-id');
  await save('response-metadata.json', { httpStatus: response.status, inferenceId });
  assert.equal(response.status, 200, 'INFERENCE_RESPONSE_NOT_SUCCESSFUL');
  const body = JSON.parse(raw);
  assert.equal(body.model, model, 'RETURNED_MODEL_MISMATCH');
  assert.equal(body.choices?.[0]?.message?.content?.trim(), 'NEAR_AI_OK', 'PROBE_RESPONSE_MISMATCH');
  assert.ok(inferenceId && /^[a-f0-9-]{36}$/.test(inferenceId), 'BILLING_ID_MISSING');
  let costNanoUsd = null;
  // These are billing lookups only. Never repeat the inference request.
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(3000);
    const r = await fetch(origin + '/v1/billing/costs', {
      method: 'POST', headers, body: JSON.stringify({ requestIds: [inferenceId] }),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) continue;
    const billing = await r.json(); await save('billing-' + i + '.json', billing);
    const row = billing.requests?.find((x) => x.requestId === inferenceId);
    if (row && !billing.warning && /^\d+$/.test(String(row.costNanoUsd)) && BigInt(row.costNanoUsd) > 0n) {
      costNanoUsd = String(row.costNanoUsd); break;
    }
  }
  const costMicros = costNanoUsd === null ? null : ((BigInt(costNanoUsd) + 999n) / 1000n).toString();
  if (costMicros !== null) assert.ok(BigInt(costMicros) <= boundMicros, 'COST_BOUND_BREACHED');
  const usage = body.usage;
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) assert.ok(Number.isSafeInteger(usage?.[k]) && usage[k] >= 0);
  const publicEvidence = {
    contractVersion: 1, scope: 'MANUAL_API_PROBE_UNVERIFIED_INFERENCE',
    label: 'Manual API Probe (Unverified Inference)', status: 'SUCCESS',
    checkedAt: new Date().toISOString(), endpoint: origin + '/v1/chat/completions',
    requestedModel: model, returnedModel: body.model, httpStatus: 200,
    responseId: body.id, inferenceId, requestSha256: hash(requestText), responseSha256: hash(raw),
    expectedResponse: 'NEAR_AI_OK', responseMatched: true,
    usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
    limits: { maxCompletionTokens: maxTokens, thinkingTokenBudget: thinkingTokens, requestCeilingUsdMicros: '100000', worstCaseUsdMicros: boundMicros.toString() },
    billing: { status: costNanoUsd === null ? 'PENDING' : 'RECONCILED', costNanoUsd, costUsdMicros: costMicros, applicationBudgetHoldUsdMicros: costMicros ?? '100000' },
    organization: { configured: true, binding: 'NOT_INDEPENDENTLY_VERIFIED', detail: 'The inference key was accepted. The completion does not expose an organization ID; configured organization membership is not independently established by this probe.' },
    security: { isolated: true, teeWorkloadApproved: false, responseSignatureVerified: false, automatedExecutionEnabled: false, treasuryInvoked: false, treasuryFundsUsed: false, blockchainTransactionsSubmitted: 0 },
    inferenceRequests: 1, automatedInferenceRequests: 0,
    sources: ['https://docs.near.ai/cloud/guides/openai-compatibility', 'https://docs.near.ai/cloud/guides/usage-reporting'],
  };
  await save('successful-probe.json', publicEvidence, true);
  await writeFile('artifacts/manual-ai-probe.json', JSON.stringify(publicEvidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'SUCCESS', model, inferenceRequests: 1, automatedInferenceRequests: 0, costNanoUsd, costUsdMicros: costMicros, teeWorkloadApproved: false, treasuryInvoked: false, privateResponseSaved: true }));
} catch (e) {
  console.error(JSON.stringify({ error: 'MANUAL_PROBE_STOPPED', reason: e.code === 'EEXIST' ? 'EXISTING_ATTEMPT_DO_NOT_REPEAT' : /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'INSPECT_PRIVATE_RECORDS', inferenceMayHaveBeenAccepted: paidPostStarted, retryInference: false, privateValuesPrinted: false }));
  process.exitCode = 1;
}
