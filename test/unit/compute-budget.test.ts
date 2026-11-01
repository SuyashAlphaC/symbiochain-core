import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { priceComputeReservation, BUDGET_MODEL } from '../../src/providers/compute-budget.js';
import type { Fetch } from '../../src/providers/http.js';
const config = () =>
  loadConfig({
    ...process.env,
    EXECUTION_MODE: 'PAPER',
    COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET',
    AI_BUDGET_ID: 'unit-budget',
    AI_TOTAL_BUDGET_USD_MICROS: '1000000',
    AI_MAX_REQUEST_USD_MICROS: '100000',
    SYNC_STAKING_CREDITS: 'false',
    NEAR_AI_MODEL: BUDGET_MODEL,
    NEAR_AI_API_KEY: 'fixture-inference-key',
    NEAR_AI_ORG_ID: '',
    NEAR_AI_SESSION_TOKEN: '',
  });
const model = () => ({
  id: BUDGET_MODEL,
  owned_by: 'nearai',
  is_ready: true,
  context_length: 1_048_576,
  supported_sampling_parameters: ['max_tokens'],
  supported_features: ['structured_outputs'],
  pricing: { prompt: '0.00000008', completion: '0.0000005', request: '0', image: '0' },
});
describe('API-key-only compute budget pricing', () => {
  it('reserves the full input context and both output limits, without an organization token', async () => {
    const c = config(),
      transport = vi.fn<Fetch>(async () =>
        Response.json({ data: [{ id: 'unrelated-model', context_length: 0 }, model()] }),
      );
    const r = await priceComputeReservation(c, transport);
    expect(r.reservedUsdMicros).toBe('84219');
    expect(r.model).toBe(BUDGET_MODEL);
    expect(JSON.stringify(r)).not.toContain(c.NEAR_AI_API_KEY);
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0]![0])).toBe('https://cloud-api.near.ai/v1/models');
  });
  it.each([
    'price',
    'context',
    'readiness',
    'provider',
    'token-limit',
    'request-fee',
    'duplicate',
    'missing',
  ])('rejects an unreviewed catalog change: %s', async (variant) => {
    const m = model();
    if (variant === 'price') m.pricing.completion = '0.0000006';
    if (variant === 'context') m.context_length = 2_000_000;
    if (variant === 'readiness') m.is_ready = false;
    if (variant === 'provider') m.owned_by = 'third-party';
    if (variant === 'token-limit') m.supported_sampling_parameters = [];
    if (variant === 'request-fee') m.pricing.request = '0.001';
    const rows = variant === 'missing' ? [] : variant === 'duplicate' ? [m, m] : [m];
    await expect(
      priceComputeReservation(config(), async () => Response.json({ data: rows })),
    ).rejects.toThrow();
  });
  it('rejects a request bound above the configured cap and invalid budget configuration', async () => {
    const c = { ...config(), AI_MAX_REQUEST_USD_MICROS: '1000' };
    await expect(
      priceComputeReservation(c, async () => Response.json({ data: [model()] })),
    ).rejects.toThrow('request budget');
    expect(() =>
      loadConfig({ ...process.env, COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET', AI_BUDGET_ID: '' }),
    ).toThrow('AI_BUDGET_ID');
    expect(() =>
      loadConfig({
        ...process.env,
        COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET',
        AI_BUDGET_ID: 'x',
        AI_TOTAL_BUDGET_USD_MICROS: '0',
      }),
    ).toThrow('positive bounded');
  });
});
