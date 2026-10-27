import { it, expect, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import {
  serializeTransaction,
  parseTransaction,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  encodeEventTopics,
  encodeAbiParameters,
} from 'viem';
import { loadConfig } from '../../src/config.js';
import { ChainWallets, type UnsignedTransfer } from '../../src/providers/wallets.js';
const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgresql://unused',
  EXECUTION_MODE: 'PAPER',
  EVM_RPC_URL: 'http://127.0.0.1:1',
});
it('does not report a finalized Solana send as complete while fee metadata is unavailable', async () => {
  const wallets = new ChainWallets(config);
  vi.spyOn(wallets.solana, 'getSignatureStatuses').mockResolvedValue({
    context: { slot: 10 },
    value: [{ slot: 10, confirmations: null, err: null, confirmationStatus: 'finalized' }],
  } as never);
  vi.spyOn(wallets.solana, 'getTransaction').mockResolvedValue(null);
  expect(
    (
      await wallets.confirmed({
        chainId: 'solana:mainnet',
        sender: 'fixture',
        txHash: 'fixture',
        raw: 'unused',
        payloadHex: 'unused',
      })
    ).confirmed,
  ).toBe(false);
});
it('rejects imprecise native balances and slot numbers instead of rounding RPC money values', async () => {
  const wallets = new ChainWallets(config);
  vi.spyOn(wallets, 'address').mockResolvedValue(Keypair.generate().publicKey.toBase58());
  vi.spyOn(wallets.solana, 'getBalance').mockResolvedValue(Number.MAX_SAFE_INTEGER + 1);
  await expect(wallets.balance('solana:mainnet', 'sol:native')).rejects.toThrow('safe integer');
  vi.spyOn(wallets.evm, 'getBlockNumber').mockResolvedValue(10n);
  vi.spyOn(wallets.solana, 'getSlot').mockResolvedValue(Number.MAX_SAFE_INTEGER + 1);
  await expect(wallets.heads()).rejects.toThrow('safe integer');
});
it('requires fresh finalized EVM receipts and never counts a repeated hash twice', async () => {
  const wallets = new ChainWallets(config),
    token = `0x${'22'.repeat(20)}` as const,
    recipient = `0x${'33'.repeat(20)}` as const,
    from = `0x${'44'.repeat(20)}` as const;
  const hash = `0x${'55'.repeat(32)}`;
  vi.spyOn(wallets.evm, 'getBlockNumber').mockResolvedValue(105n);
  vi.spyOn(wallets.evm, 'getTransactionReceipt').mockResolvedValue({
    status: 'success',
    blockNumber: 100n,
    logs: [
      {
        address: token,
        data: encodeAbiParameters([{ type: 'uint256' }], [42n]),
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: 'Transfer',
          args: { from, to: recipient },
        }),
      },
    ],
  } as never);
  expect(
    (await wallets.verifyIncoming('eip155:8453', token, recipient, '42', [hash], 99n)).verified,
  ).toBe(true);
  expect(
    (await wallets.verifyIncoming('eip155:8453', token, recipient, '42', [hash], 100n)).verified,
  ).toBe(false);
  expect(
    (await wallets.verifyIncoming('eip155:8453', token, recipient, '84', [hash, hash], 99n))
      .verified,
  ).toBe(false);
});
it('assembles and verifies an actual EVM signature through the Chain Signatures adapter', async () => {
  const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`),
    token = `0x${'22'.repeat(20)}` as const,
    recipient = `0x${'33'.repeat(20)}` as const;
  const tx = {
    type: 'eip1559' as const,
    chainId: 8453,
    nonce: 7,
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, 5000000n],
    }),
    gas: 60000n,
    maxFeePerGas: 10000n,
    maxPriorityFeePerGas: 100n,
  };
  const expected = await signer.signTransaction(tx),
    signature = parseTransaction(expected);
  const unsigned = serializeTransaction(tx);
  const transfer: UnsignedTransfer = {
    chainId: 'eip155:8453',
    sender: signer.address,
    recipient,
    amountAtoms: '5000000',
    token,
    unsigned,
    payloadHex: keccak256(unsigned).slice(2),
    signArgs: {},
    authorizationChainId: 8453,
    nativeFeeBudgetAtoms: '600000000',
  };
  const result = await new ChainWallets(config).finalize(transfer, {
    big_r: { affine_point: `02${signature.r!.slice(2)}` },
    s: { scalar: signature.s!.slice(2) },
    recovery_id: signature.yParity,
  });
  expect(result.raw).toBe(expected);
  expect(result.txHash).toBe(keccak256(expected));
});
it('assembles and verifies an actual native SOL signature without a network call', async () => {
  const signer = Keypair.generate(),
    recipient = Keypair.generate().publicKey,
    blockhash = bs58.encode(new Uint8Array(32).fill(3));
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 42n }),
  );
  const unsigned = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  tx.sign(signer);
  const transfer: UnsignedTransfer = {
    chainId: 'solana:mainnet',
    sender: signer.publicKey.toBase58(),
    recipient: recipient.toBase58(),
    amountAtoms: '42',
    token: 'sol:native',
    unsigned,
    payloadHex: tx.serializeMessage().toString('hex'),
    signArgs: {},
    authorizationChainId: 0,
    nativeFeeBudgetAtoms: '5000',
  };
  const result = await new ChainWallets(config).finalize(transfer, {
    scheme: 'Ed25519',
    signature: [...tx.signature!],
  });
  expect(result.raw).toBe(tx.serialize().toString('base64'));
  expect(result.txHash).toBe(bs58.encode(tx.signature!));
});
