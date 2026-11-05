import { expect, it } from 'vitest';
import { digest, type Quote } from '../../src/domain.js';
import { requireTestnetTransfer, TESTNET_SOL_RECIPIENT } from '../../src/testnet-execution.js';

it('binds model-reviewed recipient, amount, network and token to the transaction profile', () => {
  const sender = '2'.repeat(44);
  const route = {
    destinationTransfer: {
      chain: 'solana:devnet',
      sender,
      recipient: TESTNET_SOL_RECIPIENT,
      token: 'sol:native',
      amountAtoms: '1000000',
    },
  };
  const quote: Quote = {
    id: 'fixture',
    inputAtoms: '1000000',
    expectedOutputAtoms: '1100000',
    minimumOutputAtoms: '1090000',
    costsAtoms: '10000',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    route,
    routeDigest: digest(route),
  };
  expect(() => requireTestnetTransfer(quote, sender)).not.toThrow();
  for (const amendment of [
    { recipient: '3'.repeat(44) },
    { amountAtoms: '1000001' },
    { chain: 'solana:mainnet' },
    { token: 'other' },
  ]) {
    const altered = { destinationTransfer: { ...route.destinationTransfer, ...amendment } };
    expect(() =>
      requireTestnetTransfer({ ...quote, route: altered, routeDigest: digest(altered) }, sender),
    ).toThrow('exact fixed testnet transfer');
  }
  expect(() =>
    requireTestnetTransfer({ ...quote, routeDigest: 'aa'.repeat(32) }, sender),
  ).toThrow();
});
