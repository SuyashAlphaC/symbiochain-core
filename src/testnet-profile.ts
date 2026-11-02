import { z } from 'zod';
import { DomainError } from './domain.js';

// This profile is a separate rehearsal, never an alternative way to arm LIVE.
export const TESTNET_RPC = 'https://rpc.testnet.near.org';
export const TESTNET_HELPER = 'https://helper.testnet.near.org/account';
export const TESTNET_MPC = 'v1.signer-prod.testnet';
export const TESTNET_CHAIN_ID = 11155111;
export const TESTNET_PATH = 'symbio-testnet-rehearsal-v1';
export const TESTNET_MAX_FUNDING = 12n * 10n ** 24n;
export function requireTestnetAccount(accountId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,54}\.testnet$/.test(accountId))
    throw new DomainError('TESTNET_ACCOUNT', 'Only dedicated .testnet accounts are allowed');
}
export async function requireTestnetNetwork(
  status: () => Promise<{ chain_id: string }>,
): Promise<void> {
  if ((await status()).chain_id !== 'testnet')
    throw new DomainError('TESTNET_NETWORK', 'Rehearsal refuses a non-testnet RPC');
}
export const TestnetSecrets = z
  .object({
    root: z.string(),
    keys: z
      .object({
        owner: z.string().startsWith('ed25519:'),
        brain: z.string().startsWith('ed25519:'),
        hand: z.string().startsWith('ed25519:'),
        books: z.string().startsWith('ed25519:'),
        treasury: z.string().startsWith('ed25519:'),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      requireTestnetAccount(value.root);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Dedicated testnet root required' });
    }
    if (value.root.length > 50)
      ctx.addIssue({ code: 'custom', message: 'Testnet root leaves no room for subaccounts' });
    if (new Set(Object.values(value.keys)).size !== 5)
      ctx.addIssue({ code: 'custom', message: 'Rehearsal roles require separate keys' });
  });
