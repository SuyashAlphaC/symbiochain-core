import { chainAdapters, contracts } from 'chainsig.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { erc20Abi, parseEventLogs, type Address, type Hex } from 'viem';
import bs58 from 'bs58';
import { loadConfig } from './config.js';
import { digest, DomainError, type Quote } from './domain.js';
import { TestnetLedger, optionalJson, privateJson } from './testnet-ledger.js';
import { TESTNET_CHAIN_ID, TESTNET_MPC, TESTNET_PATH, TESTNET_RPC } from './testnet-profile.js';
import { TestnetExecutionReport } from './testnet-swarm.js';
import { ChainWallets, type UnsignedTransfer, type SignedTransfer } from './providers/wallets.js';
import type { Authorization, ContractCycle } from './providers/near-contract.js';

export const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const TESTNET_SOL_RECIPIENT = new PublicKey(Buffer.alloc(32, 2)).toBase58();
export function requireTestnetTransfer(quote: Quote, sender: string): void {
  const expected = {
    chain: 'solana:devnet',
    sender,
    recipient: TESTNET_SOL_RECIPIENT,
    token: 'sol:native',
    amountAtoms: '1000000',
  };
  if (
    quote.routeDigest !== digest(quote.route) ||
    digest(quote.route.destinationTransfer) !== digest(expected)
  )
    throw new DomainError(
      'TESTNET_ROUTE_BINDING',
      'Approved route must commit the exact fixed testnet transfer',
    );
}
export type TestChain = 'eip155:11155111' | 'solana:devnet';
type Plan = {
  binding: string;
  authorization: Authorization;
  transfer: UnsignedTransfer;
  signed?: SignedTransfer;
};
export class TestnetExecutor {
  readonly wallets: ChainWallets;
  constructor(readonly ledger: TestnetLedger) {
    this.wallets = new ChainWallets(
      loadConfig({
        EXECUTION_MODE: 'PAPER',
        DATABASE_URL: 'postgresql://unused',
        ADMIN_TOKEN: 'testnet-unused-administration-000000000',
        READ_TOKEN: 'testnet-unused-read-000000000000000000',
        EVIDENCE_ENCRYPTION_KEY: 'aa'.repeat(32),
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: TESTNET_RPC,
        NEAR_CONTRACT_ID: ledger.accounts.treasury.accountId,
        CHAIN_SIGNATURES_CONTRACT: TESTNET_MPC,
        CHAIN_DERIVATION_PATH: TESTNET_PATH,
        EVM_CHAIN_ID: String(TESTNET_CHAIN_ID),
        EVM_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
        SOLANA_RPC_URL: 'https://api.devnet.solana.com',
        EVM_MAX_FEE_PER_GAS_WEI: '50000000000',
        EVM_MAX_GAS: '150000',
        EVM_CONFIRMATIONS: '2',
      }),
    );
  }
  async network(chain: TestChain) {
    await this.ledger.network();
    if (chain === 'eip155:11155111') {
      if ((await this.wallets.evm.getChainId()) !== TESTNET_CHAIN_ID)
        throw new DomainError('TESTNET_EVM_NETWORK', 'Expected Sepolia');
    } else if ((await this.wallets.solana.getGenesisHash()) !== DEVNET_GENESIS)
      throw new DomainError('TESTNET_SOLANA_NETWORK', 'Expected Solana devnet');
  }
  async address(chain: TestChain): Promise<string> {
    await this.network(chain);
    if (chain === 'eip155:11155111') return this.wallets.address(chain);
    const contract = new contracts.ChainSignatureContract({
      contractId: TESTNET_MPC,
      networkId: 'testnet',
      fallbackRpcUrls: [TESTNET_RPC],
    });
    return (
      await new chainAdapters.solana.Solana({
        solanaConnection: this.wallets.solana,
        contract,
      }).deriveAddressAndPublicKey(this.ledger.accounts.treasury.accountId, TESTNET_PATH)
    ).address;
  }
  async execute(
    runId: string,
    chain: TestChain,
    source: TestnetExecutionReport['source'],
    evidenceHash: string,
    proposalHash: string,
    routeHash: string,
  ): Promise<TestnetExecutionReport> {
    await this.network(chain);
    const directory = this.ledger.directory,
      name = chain === 'solana:devnet' ? 'solana' : 'evm';
    const path = `${directory}/${runId}-${name}-plan.json`;
    const binding = digest({ runId, chain, source, evidenceHash, proposalHash, routeHash });
    let plan = (await optionalJson(path)) as Plan | null;
    if (plan && plan.binding !== binding)
      throw new DomainError('TESTNET_EXECUTION_CONFLICT', 'Execution terms changed');
    if (!plan) {
      const sender = await this.address(chain);
      let transfer: UnsignedTransfer;
      if (chain === 'eip155:11155111') {
        if (
          (await this.wallets.evm.getBalance({ address: sender as Address })) < 1_000_000_000_000n
        )
          throw new DomainError('TESTNET_EVM_GAS_REQUIRED', 'Faucet Sepolia ETH required');
        const bytecode = await this.wallets.evm.getCode({ address: SEPOLIA_USDC });
        if (!bytecode || bytecode === '0x')
          throw new DomainError('TESTNET_ERC20_CODE', 'Expected real Sepolia test USDC bytecode');
        if (
          (await this.wallets.evm.readContract({
            address: SEPOLIA_USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [sender as Address],
          })) < 1_000_000n
        )
          throw new DomainError('TESTNET_USDC_REQUIRED', 'One faucet test USDC required');
        transfer = await this.wallets.prepare(
          chain,
          SEPOLIA_USDC,
          `0x${'22'.repeat(20)}`,
          '1000000',
        );
        const policy = await this.ledger.view<
          Record<string, unknown> & { allowed_token_contracts: string[] }
        >('get_policy');
        if (
          !policy.allowed_token_contracts.some(
            (t) => t.toLowerCase() === SEPOLIA_USDC.toLowerCase(),
          )
        ) {
          // Replace only the old fake ERC-20 fixture address, preserving every numerical limit.
          const tokens = policy.allowed_token_contracts.map((t) =>
            t === `0x${'11'.repeat(20)}` ? SEPOLIA_USDC : t,
          );
          if (!tokens.includes(SEPOLIA_USDC))
            throw new DomainError('TESTNET_TOKEN_POLICY', 'Unexpected rehearsal token policy');
          await this.ledger.call('sepolia-test-usdc-policy', 'owner', 'set_policy', {
            policy: { ...policy, allowed_token_contracts: tokens },
          });
        }
      } else {
        if ((await this.wallets.solana.getBalance(new PublicKey(sender), 'finalized')) < 1_010_000)
          throw new DomainError('TESTNET_SOL_REQUIRED', 'Faucet devnet SOL required');
        const block = await this.wallets.solana.getLatestBlockhash('finalized');
        const recipient = new PublicKey(TESTNET_SOL_RECIPIENT);
        const tx = new Transaction({
          feePayer: new PublicKey(sender),
          recentBlockhash: block.blockhash,
        }).add(
          SystemProgram.transfer({
            fromPubkey: new PublicKey(sender),
            toPubkey: recipient,
            lamports: 1_000_000n,
          }),
        );
        transfer = {
          chainId: chain,
          sender,
          recipient: recipient.toBase58(),
          amountAtoms: '1000000',
          token: 'sol:native',
          unsigned: tx
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString('base64'),
          payloadHex: tx.serializeMessage().toString('hex'),
          nativeFeeBudgetAtoms: '10000',
          authorizationChainId: 0,
          signArgs: {
            sender_hex: new PublicKey(sender).toBuffer().toString('hex'),
            recent_blockhash_hex: Buffer.from(bs58.decode(block.blockhash)).toString('hex'),
          },
        };
      }
      const block = await this.ledger.provider.viewBlock({ finality: 'final' });
      plan = {
        binding,
        transfer,
        authorization: this.wallets.authorization(transfer, {
          cycle_id: `testnet-swarm:${runId}:${name}`,
          proposal_hash: proposalHash,
          route_hash: routeHash,
          evidence_hash: evidenceHash,
          amount_atoms: transfer.amountAtoms,
          budget_atoms: transfer.amountAtoms,
          expires_at_ns: (BigInt(block.header.timestamp_nanosec) + 3_500_000_000_000n).toString(),
          slippage_bps: 50,
        }),
      };
      await privateJson(path, plan);
    }
    const prefix = `${runId}:${name}`,
      cycleId = plan.authorization.cycle_id;
    if (!plan.signed) {
      await this.ledger.paused(false);
      await this.ledger.call(`${prefix}:authorize`, 'brain', 'authorize_cycle', {
        authorization: plan.authorization,
      });
      await this.ledger.call(
        `${prefix}:sign`,
        'hand',
        chain === 'solana:devnet' ? 'request_solana_signature' : 'request_evm_signature',
        { cycle_id: cycleId, ...plan.transfer.signArgs },
        0n,
        300_000_000_000_000n,
      );
      const cycle = await this.ledger.view<ContractCycle>('get_cycle', { cycle_id: cycleId });
      if (
        cycle.status !== 'SIGNED' ||
        cycle.payload_hex !== plan.transfer.payloadHex ||
        !cycle.signature
      )
        throw new DomainError(
          'TESTNET_MPC_PAYLOAD',
          'MPC signature must bind the exact committed transaction',
        );
      plan.signed = await this.wallets.finalize(plan.transfer, JSON.parse(cycle.signature));
      await privateJson(path, plan); // Persist transaction identity and exact bytes BEFORE broadcasting.
    }
    await this.network(chain);
    let confirmation = await this.wallets.confirmed(plan.signed);
    if (!confirmation.confirmed) {
      if (chain === 'solana:devnet') {
        const blockhash = Transaction.from(
          Buffer.from(plan.transfer.unsigned, 'base64'),
        ).recentBlockhash!;
        if (
          !(await this.wallets.solana.isBlockhashValid(blockhash, { commitment: 'finalized' }))
            .value
        )
          throw new DomainError(
            'TESTNET_BLOCKHASH_EXPIRED',
            'Reconcile the original signature; never silently resign',
          );
      }
      await this.wallets.broadcast(plan.signed); // Retries use the identical raw transaction/hash only.
      confirmation = await this.wallets.confirmed(plan.signed);
    }
    if (!confirmation.confirmed)
      throw new DomainError(
        'TESTNET_CONFIRMATION_PENDING',
        'Resume to inspect the same transaction identity',
      );
    if (confirmation.failed)
      throw new DomainError('TESTNET_DESTINATION_FAILED', 'Destination transaction failed');
    if (chain === 'eip155:11155111') {
      const receipt = await this.wallets.evm.getTransactionReceipt({
        hash: plan.signed.txHash as Hex,
      });
      const transfers = parseEventLogs({
        abi: erc20Abi,
        eventName: 'Transfer',
        logs: receipt.logs.filter(
          (l) => l.address.toLowerCase() === plan!.transfer.token.toLowerCase(),
        ),
      });
      if (
        !transfers.some(
          (log) =>
            log.args.from.toLowerCase() === plan!.signed!.sender.toLowerCase() &&
            log.args.to.toLowerCase() === plan!.transfer.recipient.toLowerCase() &&
            log.args.value === BigInt(plan!.transfer.amountAtoms),
        )
      )
        throw new DomainError(
          'TESTNET_TRANSFER_LOG',
          'Confirmed transaction lacks the committed ERC-20 transfer',
        );
    }
    await this.ledger.call(`${prefix}:submission`, 'hand', 'record_submission', {
      cycle_id: cycleId,
      tx_hash: plan.signed.txHash,
    });
    return TestnetExecutionReport.parse({
      chain,
      source,
      sender: plan.signed.sender,
      status: 'CONFIRMED',
      code: 'CONFIRMED',
      txHash: plan.signed.txHash,
      nativeFeeAtoms: confirmation.nativeFeeAtoms,
    });
  }
}
