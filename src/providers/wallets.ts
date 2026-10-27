import { chainAdapters, contracts, type MPCSignature, type RSVSignature } from 'chainsig.js';
import {
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  serializeTransaction,
  keccak256,
  recoverTransactionAddress,
  parseEventLogs,
  type Hex,
  type Address,
  type TransactionSerializedEIP1559,
} from 'viem';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Config } from '../config.js';
import { DomainError } from '../domain.js';
import type { Authorization } from './near-contract.js';

export interface UnsignedTransfer {
  chainId: string;
  sender: string;
  recipient: string;
  amountAtoms: string;
  token: string;
  unsigned: string;
  payloadHex: string;
  signArgs: Record<string, unknown>;
  authorizationChainId: number;
  nativeFeeBudgetAtoms: string;
}
export interface SignedTransfer {
  chainId: string;
  sender: string;
  txHash: string;
  raw: string;
  payloadHex: string;
}
function rpcInteger(value: number | undefined, label: string): bigint {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new DomainError(
      'RPC_UNSAFE_INTEGER',
      `Solana ${label} is missing or is not a safe integer`,
    );
  return BigInt(value);
}
export class ChainWallets {
  readonly evm;
  readonly solana: Connection;
  private readonly adapter;
  private readonly solanaAdapter;
  constructor(readonly config: Config) {
    const chain = defineChain({
      id: config.EVM_CHAIN_ID,
      name: 'configured EVM',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.EVM_RPC_URL] } },
    });
    this.evm = createPublicClient({
      chain,
      transport: http(config.EVM_RPC_URL, { timeout: 15000, retryCount: 0 }),
    });
    this.solana = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'finalized',
      confirmTransactionInitialTimeout: 30000,
      disableRetryOnRateLimit: true,
    });
    const contract = new contracts.ChainSignatureContract({
      contractId: config.CHAIN_SIGNATURES_CONTRACT,
      networkId: config.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
      fallbackRpcUrls: [config.NEAR_RPC_URL],
    });
    this.adapter = new chainAdapters.evm.EVM({ publicClient: this.evm, contract });
    this.solanaAdapter = new chainAdapters.solana.Solana({
      solanaConnection: this.solana,
      contract,
    });
  }
  async address(chainId: string): Promise<string> {
    if (chainId === `eip155:${this.config.EVM_CHAIN_ID}`)
      return (
        await this.adapter.deriveAddressAndPublicKey(
          this.config.NEAR_CONTRACT_ID,
          this.config.CHAIN_DERIVATION_PATH,
        )
      ).address;
    if (chainId === 'solana:mainnet')
      return (
        await this.solanaAdapter.deriveAddressAndPublicKey(
          this.config.NEAR_CONTRACT_ID,
          this.config.CHAIN_DERIVATION_PATH,
        )
      ).address;
    throw new DomainError(
      'CHAIN_UNSUPPORTED',
      'Only the configured EVM chain and native Solana transfers are supported',
    );
  }
  async heads(): Promise<{ evmBlock: bigint; solanaSlot: bigint }> {
    const [evmBlock, slot] = await Promise.all([
      this.evm.getBlockNumber(),
      this.solana.getSlot('confirmed'),
    ]);
    return { evmBlock, solanaSlot: rpcInteger(slot, 'slot') };
  }
  async balance(chainId: string, token: string, blockNumber?: bigint): Promise<bigint> {
    const sender = await this.address(chainId);
    if (chainId.startsWith('eip155:'))
      return this.evm.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [sender as Address],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
    const value = await this.solana.getBalance(new PublicKey(sender), 'finalized');
    return rpcInteger(value, 'balance');
  }
  async prepare(
    chainId: string,
    token: string,
    recipient: string,
    amountAtoms: string,
  ): Promise<UnsignedTransfer> {
    const sender = await this.address(chainId),
      amount = BigInt(amountAtoms),
      c = this.config;
    if (chainId.startsWith('eip155:')) {
      if ((await this.evm.getChainId()) !== c.EVM_CHAIN_ID)
        throw new DomainError('RPC_CHAIN', 'EVM RPC is serving the wrong chain');
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient as Address, amount],
      });
      const fees = await this.evm.estimateFeesPerGas();
      if (fees.maxFeePerGas > BigInt(c.EVM_MAX_FEE_PER_GAS_WEI))
        throw new DomainError('GAS_CAP', 'Current gas exceeds the configured cap');
      const gas = await this.evm.estimateGas({
        account: sender as Address,
        to: token as Address,
        data,
        value: 0n,
      });
      const gasLimit = (gas * 120n + 99n) / 100n;
      if (gasLimit > BigInt(c.EVM_MAX_GAS))
        throw new DomainError('GAS_CAP', 'Estimated gas exceeds the configured cap');
      if (
        (await this.evm.getBalance({ address: sender as Address })) <
        gasLimit * fees.maxFeePerGas
      )
        throw new DomainError('GAS_BALANCE', 'Fund the derived EVM wallet with native gas');
      if ((await this.balance(chainId, token)) < amount)
        throw new DomainError('TOKEN_BALANCE', 'Insufficient confirmed token balance');
      const nonce = await this.evm.getTransactionCount({
        address: sender as Address,
        blockTag: 'pending',
      });
      const unsigned = serializeTransaction({
        type: 'eip1559',
        chainId: c.EVM_CHAIN_ID,
        nonce,
        to: token as Address,
        value: 0n,
        data,
        gas: gasLimit,
        ...fees,
      });
      return {
        chainId,
        sender,
        recipient,
        amountAtoms,
        token,
        unsigned,
        payloadHex: keccak256(unsigned).slice(2),
        authorizationChainId: c.EVM_CHAIN_ID,
        nativeFeeBudgetAtoms: (gasLimit * fees.maxFeePerGas).toString(),
        signArgs: {
          transaction: {
            nonce: nonce.toString(),
            max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
            max_fee_per_gas: fees.maxFeePerGas.toString(),
            gas_limit: gasLimit.toString(),
          },
        },
      };
    }
    if (token !== 'sol:native')
      throw new DomainError('TOKEN_UNSUPPORTED', 'Solana signing supports native SOL only');
    const genesis = await this.solana.getGenesisHash();
    if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
      throw new DomainError('RPC_CHAIN', 'Expected Solana mainnet');
    if ((await this.balance(chainId, token)) < amount + BigInt(c.SOLANA_FEE_RESERVE_LAMPORTS))
      throw new DomainError('GAS_BALANCE', 'Keep the configured native SOL fee reserve');
    const block = await this.solana.getLatestBlockhash('finalized');
    const tx = new Transaction({
      feePayer: new PublicKey(sender),
      recentBlockhash: block.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(sender),
        toPubkey: new PublicKey(recipient),
        lamports: amount,
      }),
    );
    const message = tx.serializeMessage();
    return {
      chainId,
      sender,
      recipient,
      amountAtoms,
      token,
      unsigned: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      payloadHex: message.toString('hex'),
      authorizationChainId: 0,
      nativeFeeBudgetAtoms: '5000',
      signArgs: {
        sender_hex: new PublicKey(sender).toBuffer().toString('hex'),
        recent_blockhash_hex: Buffer.from(bs58.decode(block.blockhash)).toString('hex'),
      },
    };
  }
  authorization(
    t: UnsignedTransfer,
    base: Omit<
      Authorization,
      'chain_id' | 'token_contract' | 'deposit_address' | 'max_fee_per_gas' | 'gas_limit'
    >,
  ): Authorization {
    return {
      ...base,
      chain_id: t.authorizationChainId,
      token_contract: t.token,
      deposit_address: t.chainId.startsWith('eip155:')
        ? t.recipient
        : new PublicKey(t.recipient).toBuffer().toString('hex'),
      max_fee_per_gas: this.config.EVM_MAX_FEE_PER_GAS_WEI,
      gas_limit: this.config.EVM_MAX_GAS,
    };
  }
  async finalize(t: UnsignedTransfer, rawSignature: unknown): Promise<SignedTransfer> {
    const s = contracts.utils.transaction.responseToMpcSignature({
      signature: rawSignature as MPCSignature,
    });
    if (!s) throw new DomainError('MPC_SIGNATURE', 'Unsupported MPC response');
    let raw: string, txHash: string;
    if (t.chainId.startsWith('eip155:')) {
      if (!('r' in s)) throw new DomainError('MPC_SIGNATURE', 'Expected ECDSA signature');
      raw = this.adapter.finalizeTransactionSigning({
        transaction: this.adapter.deserializeTransaction(t.unsigned as Hex),
        rsvSignatures: [s as RSVSignature],
      });
      if (
        (
          await recoverTransactionAddress({
            serializedTransaction: raw as TransactionSerializedEIP1559,
          })
        ).toLowerCase() !== t.sender.toLowerCase()
      )
        throw new DomainError('MPC_SIGNER', 'Signature does not recover the derived wallet');
      txHash = keccak256(raw as Hex);
    } else {
      if (!('signature' in s) || s.signature.length !== 64)
        throw new DomainError('MPC_SIGNATURE', 'Expected Ed25519 signature');
      const tx = Transaction.from(Buffer.from(t.unsigned, 'base64'));
      tx.addSignature(new PublicKey(t.sender), Buffer.from(s.signature));
      if (!tx.verifySignatures())
        throw new DomainError('MPC_SIGNER', 'Invalid derived Solana wallet signature');
      raw = tx.serialize().toString('base64');
      txHash = bs58.encode(s.signature);
    }
    return { chainId: t.chainId, sender: t.sender, raw, txHash, payloadHex: t.payloadHex };
  }
  async broadcast(t: SignedTransfer): Promise<void> {
    let hash: string;
    if (t.chainId.startsWith('eip155:'))
      hash = await this.evm.sendRawTransaction({ serializedTransaction: t.raw as Hex });
    else
      hash = await this.solana.sendRawTransaction(Buffer.from(t.raw, 'base64'), {
        skipPreflight: false,
        maxRetries: 0,
      });
    if (hash !== t.txHash)
      throw new DomainError('TX_HASH', 'RPC returned a different transaction identity');
  }
  async confirmed(
    t: SignedTransfer,
  ): Promise<{ confirmed: boolean; failed: boolean; nativeFeeAtoms: string }> {
    if (t.chainId.startsWith('eip155:')) {
      const receipt = await this.evm
        .getTransactionReceipt({ hash: t.txHash as Hex })
        .catch(() => null);
      if (!receipt) return { confirmed: false, failed: false, nativeFeeAtoms: '0' };
      const head = await this.evm.getBlockNumber();
      return {
        confirmed: head - receipt.blockNumber + 1n >= BigInt(this.config.EVM_CONFIRMATIONS),
        failed: receipt.status !== 'success',
        nativeFeeAtoms: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      };
    }
    const status = (
      await this.solana.getSignatureStatuses([t.txHash], { searchTransactionHistory: true })
    ).value[0];
    const finalized = status?.confirmationStatus === 'finalized';
    const tx = finalized
      ? await this.solana.getTransaction(t.txHash, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        })
      : null;
    if (finalized && !tx?.meta)
      return { confirmed: false, failed: !!status?.err, nativeFeeAtoms: '0' };
    return {
      confirmed: finalized,
      failed: !!status?.err || !!tx?.meta?.err,
      nativeFeeAtoms: tx?.meta ? rpcInteger(tx.meta.fee, 'transaction fee').toString() : '0',
    };
  }
  async verifyIncoming(
    chainId: string,
    token: string,
    recipient: string,
    amount: string,
    hashes: string[],
    minimumBlock: bigint,
  ): Promise<{ verified: boolean; transfers: Array<{ txHash: string; amountAtoms: string }> }> {
    let received = 0n;
    const transfers: Array<{ txHash: string; amountAtoms: string }> = [];
    for (const hash of [...new Set(hashes)]) {
      const before = received;
      if (chainId.startsWith('eip155:')) {
        const receipt = await this.evm.getTransactionReceipt({ hash: hash as Hex });
        if (
          receipt.status !== 'success' ||
          receipt.blockNumber <= minimumBlock ||
          (await this.evm.getBlockNumber()) - receipt.blockNumber + 1n <
            BigInt(this.config.EVM_CONFIRMATIONS)
        )
          return { verified: false, transfers: [] };
        const logs = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Transfer',
          logs: receipt.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()),
        });
        for (const log of logs)
          if (log.args.to.toLowerCase() === recipient.toLowerCase()) received += log.args.value;
      } else {
        const tx = await this.solana.getTransaction(hash, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta || tx.meta.err || rpcInteger(tx.slot, 'transaction slot') <= minimumBlock)
          return { verified: false, transfers: [] };
        const keys = tx.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta.loadedAddresses ?? null,
        });
        for (let i = 0; i < keys.length; i++)
          if (keys.get(i)?.toBase58() === recipient) {
            const delta =
              rpcInteger(tx.meta.postBalances[i], 'post balance') -
              rpcInteger(tx.meta.preBalances[i], 'pre balance');
            if (delta > 0n) received += delta;
          }
      }
      if (received > before)
        transfers.push({ txHash: hash, amountAtoms: (received - before).toString() });
    }
    return { verified: received >= BigInt(amount), transfers };
  }
}
