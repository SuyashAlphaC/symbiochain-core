import { describe, it, expect } from 'vitest';
import { Proposal, canonical, digest, assertTransition, netProfit } from '../../src/domain.js';
import { seal, unseal } from '../../src/crypto.js';
import { loadConfig } from '../../src/config.js';

describe('money and authorization boundaries', () => {
  it('rejects fractional, negative and exponent token quantities', () => {
    for (const amountAtoms of ['1.5', '-1', '1e6', '01'])
      expect(() =>
        Proposal.parse({
          strategy: 'round-trip',
          originChain: 'near:paper',
          destinationChain: 'eip155:31337',
          originAsset: 'USDC',
          intermediateAsset: 'WNEAR',
          amountAtoms,
          recipient: 'paper.treasury',
          refundTo: 'paper.treasury',
          slippageBps: 50,
          expiresAt: new Date().toISOString(),
        }),
      ).toThrow();
  });
  it('canonical commitments survive key ordering and change when the recipient changes', () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({ recipient: 'alice' })).not.toBe(digest({ recipient: 'mallory' }));
    expect(canonical({ value: '1000000000000000000000000' })).toContain(
      '1000000000000000000000000',
    );
  });
  it('cannot turn an unknown submission back into a new signing attempt', () => {
    expect(() => assertTransition('UNKNOWN', 'RESERVED')).toThrow();
    expect(() => assertTransition('CLOSED', 'SUBMITTED')).toThrow();
    expect(() => assertTransition('UNKNOWN', 'RECONCILED')).not.toThrow();
  });
  it('includes costs when deciding whether an apparent spread is profitable', () => {
    expect(
      netProfit({
        id: 'q',
        inputAtoms: '1000000',
        expectedOutputAtoms: '1020000',
        minimumOutputAtoms: '1005000',
        costsAtoms: '10000',
        expiresAt: new Date().toISOString(),
        routeDigest: 'a'.repeat(64),
        route: {},
      }),
    ).toBe(-5000n);
  });
  it('binds encrypted evidence to its cycle and detects tampering', () => {
    const key = 'a'.repeat(64),
      sealed = seal({ prompt: 'private' }, key, 'cycle-1');
    expect(unseal(sealed, key, 'cycle-1')).toEqual({ prompt: 'private' });
    expect(() => unseal(sealed, key, 'cycle-2')).toThrow();
    expect(() => unseal(sealed.slice(0, -4) + 'AAAA', key, 'cycle-1')).toThrow();
  });
  it('does not silently arm real funds with demo credentials', () => {
    expect(() =>
      loadConfig({ ...process.env, EXECUTION_MODE: 'LIVE', LIVE_TRADING_ENABLED: 'false' }),
    ).toThrow();
  });
  it('permits unauthenticated 1Click access without weakening live authorization gates', () => {
    const env = {
      DATABASE_URL: 'postgresql://unused',
      ADMIN_TOKEN: 'a'.repeat(32),
      READ_TOKEN: 'b'.repeat(32),
      EVIDENCE_ENCRYPTION_KEY: '11'.repeat(32),
      EXECUTION_MODE: 'LIVE',
      LIVE_TRADING_ENABLED: 'true',
      NEAR_NETWORK: 'mainnet',
      NEAR_CONTRACT_ID: 'treasury.test.near',
      NEAR_WORKER_ACCOUNT_ID: 'hand.test.near',
      NEAR_WORKER_PRIVATE_KEY: 'test-treasury-hand-key',
      NEAR_BRAIN_ACCOUNT_ID: 'brain.test.near',
      NEAR_BRAIN_PRIVATE_KEY: 'test-treasury-brain-key',
      NEAR_SCOUT_ACCOUNT_ID: 'scout.test.near',
      NEAR_ACCOUNTANT_ACCOUNT_ID: 'accountant.test.near',
      NEAR_ACCOUNTANT_PRIVATE_KEY: 'test-accountant-key',
      NEAR_AI_API_KEY: 'test-inference-key',
      NEAR_AI_MODEL: 'test-model',
      NEAR_AI_ORG_ID: 'test-organization',
      NEAR_AI_SESSION_TOKEN: 'test-session',
      TEE_GATEWAY_COMPOSE_HASHES: '22'.repeat(32),
      TEE_MODEL_COMPOSE_HASHES: '33'.repeat(32),
      EVM_RPC_URL: 'https://rpc.invalid',
      NFT_RECEIVER_ID: 'receiver.test.near',
      INTENTS_BRAIN_PRIVATE_KEY: 'test-intents-brain-key',
      INTENTS_HAND_PRIVATE_KEY: 'test-intents-hand-key',
      ONECLICK_JWT: '',
    };
    expect(loadConfig(env).ONECLICK_JWT).toBe('');
    expect(() => loadConfig({ ...env, LIVE_TRADING_ENABLED: 'false' })).toThrow(
      'LIVE_TRADING_ENABLED',
    );
    expect(() => loadConfig({ ...env, TEE_MODEL_COMPOSE_HASHES: '' })).toThrow(
      'independently approved',
    );
    expect(() => loadConfig({ ...env, NEAR_AI_API_KEY: '' })).toThrow('NEAR_AI_API_KEY');
  });
});
