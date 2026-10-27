import type { QuoteResponse, TokenResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { PublicKey } from '@solana/web3.js';
import type { Providers } from './types.js';
import { OneClickClient, type SwapTerms } from './oneclick.js';
import { NearAiClient } from './near-ai.js';
import { NearTreasury, type Authorization } from './near-contract.js';
import { ChainWallets, type UnsignedTransfer, type SignedTransfer } from './wallets.js';
import { Store, json } from '../store.js';
import {
  DomainError,
  digest,
  type Proposal,
  type Quote,
  type PreparedExecution,
  type Settlement,
} from '../domain.js';
import { seal, unseal } from '../crypto.js';
import { IntentPayments } from './intent-payments.js';
import { totalApprovedCost } from '../cost-basis.js';

interface Route {
  first: QuoteResponse;
  second: QuoteResponse;
  originToken: TokenResponse;
  intermediateToken: TokenResponse;
  originAddress: string;
  intermediateAddress: string;
}
interface LegPayload {
  terms: SwapTerms;
  quote: QuoteResponse;
  unsigned: UnsignedTransfer;
  authorization: Authorization;
  signed?: SignedTransfer;
  nativeFeeAtoms?: string;
  statusEvidence?: unknown;
  beforeBlocks: { evm: string; solana: string };
}
const pending = (evidence: Record<string, unknown> = {}): Settlement => ({
  status: 'PENDING',
  receivedAtoms: '0',
  feesAtoms: '0',
  transactions: [],
  evidence,
});

/** Explicit transport ports permit recovery tests of this orchestration without live funds.
 * Production composition uses the concrete providers; no environment flag substitutes evidence.
 */
export interface LivePorts {
  oneclick: Pick<OneClickClient, 'tokens' | 'quote' | 'status' | 'notify'>;
  ai: Pick<NearAiClient, 'assess'>;
  treasury: Pick<NearTreasury, 'authorize' | 'cycle' | 'call' | 'service'>;
  wallets: Pick<
    ChainWallets,
    | 'address'
    | 'balance'
    | 'heads'
    | 'prepare'
    | 'authorization'
    | 'finalize'
    | 'broadcast'
    | 'confirmed'
    | 'verifyIncoming'
  >;
  payments: Pick<IntentPayments, 'settle'>;
}

export class LiveProviders implements Providers {
  readonly oneclick: LivePorts['oneclick'];
  readonly ai: LivePorts['ai'];
  readonly treasury: LivePorts['treasury'];
  readonly wallets: LivePorts['wallets'];
  readonly payments: LivePorts['payments'];
  constructor(
    readonly store: Store,
    ports: Partial<LivePorts> = {},
  ) {
    if (store.mode !== 'LIVE')
      throw new Error('Live provider cannot be attached to another evidence mode');
    this.oneclick = ports.oneclick ?? new OneClickClient(store.config);
    this.ai = ports.ai ?? new NearAiClient(store.config, store.db);
    this.treasury = ports.treasury ?? new NearTreasury(store.config);
    this.wallets = ports.wallets ?? new ChainWallets(store.config);
    this.payments = ports.payments ?? new IntentPayments(store);
  }
  private async pay(
    cycleId: string,
    suffix: string,
    recipient: string,
    reference: string,
    role: 'HAND' | 'BRAIN',
  ) {
    if (this.store.config.SERVICE_PAYMENT_RAIL === 'INTENTS')
      return this.payments.settle(cycleId, `${cycleId}:${suffix}`, role, recipient, reference);
    await this.treasury.service(`${cycleId}:${suffix}`, recipient, reference, role);
  }
  async reconcileIdleBalance(): Promise<void> {
    // Reconciliation is serialized against reservations. In-flight capital is never mistaken for a withdrawal.
    if (await this.store.db.reservation.count({ where: { mode: 'LIVE', status: 'ACTIVE' } }))
      return;
    const c = this.store.config,
      tokens = await this.oneclick.tokens(),
      base = tokens.find((t) => t.assetId === c.BASE_ASSET);
    if (!base?.contractAddress || base.decimals !== c.BASE_DECIMALS)
      throw new DomainError('BASE_METADATA', 'Configure a supported ERC-20 base asset');
    const chainId = `eip155:${c.EVM_CHAIN_ID}`,
      address = await this.wallets.address(chainId);
    const { evmBlock: head } = await this.wallets.heads();
    const block = head - BigInt(c.EVM_CONFIRMATIONS) + 1n;
    if (block < 0n)
      throw new DomainError(
        'CHAIN_NOT_READY',
        'Configured confirmation depth exceeds the chain head',
      );
    const observed = await this.wallets.balance(chainId, base.contractAddress, block);
    await this.store.atomic(async (tx) => {
      await tx.$queryRaw`SELECT mode FROM "Policy" WHERE mode::text=${this.store.mode} FOR UPDATE`;
      if (await tx.reservation.count({ where: { mode: 'LIVE', status: 'ACTIVE' } })) return;
      const difference = observed - (await this.store.balance(tx));
      if (difference === 0n) return;
      // Balance differences cannot prove a customer sale. They are excluded from revenue.
      await this.store.journal(
        tx,
        `balance:${chainId}:${address}:${block}`,
        'EXTERNAL_BALANCE_RECONCILIATION',
        [
          { account: 'TREASURY', asset: c.BASE_ASSET, amountAtoms: difference },
          {
            account: 'UNATTRIBUTED_EXTERNAL_CAPITAL',
            asset: c.BASE_ASSET,
            amountAtoms: -difference,
          },
        ],
      );
      await this.store.event(tx, 'treasury.reconciled', {
        chainId,
        address,
        block: block.toString(),
        observedAtoms: observed.toString(),
        deltaAtoms: difference.toString(),
        classification: 'EXTERNAL_CAPITAL_NOT_REVENUE',
      });
    });
  }
  private async route(p: Proposal): Promise<Omit<Route, 'first' | 'second'>> {
    const c = this.store.config,
      tokens = await this.oneclick.tokens();
    const originToken = tokens.find((t) => t.assetId === p.originAsset),
      intermediateToken = tokens.find((t) => t.assetId === p.intermediateAsset);
    if (!originToken || !intermediateToken)
      throw new DomainError('ASSET_METADATA', 'Asset is not in the current 1Click registry');
    if (p.originAsset !== c.BASE_ASSET || originToken.decimals !== c.BASE_DECIMALS)
      throw new DomainError(
        'BASE_DENOMINATION',
        'Origin must match the ledger base asset and decimals',
      );
    const chainNames: Record<number, string> = { 1: 'eth', 8453: 'base', 42161: 'arb', 10: 'op' };
    const expected = chainNames[c.EVM_CHAIN_ID];
    if (
      !expected ||
      originToken.blockchain !== expected ||
      p.originChain !== `eip155:${c.EVM_CHAIN_ID}` ||
      !originToken.contractAddress?.match(/^0x[a-fA-F0-9]{40}$/)
    )
      throw new DomainError('ORIGIN_CHAIN', 'Origin must be an ERC-20 on the configured EVM chain');
    if (
      p.destinationChain !== 'solana:mainnet' ||
      intermediateToken.assetId !== 'nep141:sol.omft.near' ||
      intermediateToken.blockchain !== 'sol' ||
      intermediateToken.symbol !== 'SOL' ||
      intermediateToken.decimals !== 9 ||
      intermediateToken.contractAddress
    )
      throw new DomainError(
        'INTERMEDIATE_CHAIN',
        'This strategy supports native SOL as the intermediate asset',
      );
    const originAddress = await this.wallets.address(p.originChain),
      intermediateAddress = await this.wallets.address(p.destinationChain);
    if (
      p.recipient.toLowerCase() !== originAddress.toLowerCase() ||
      p.refundTo.toLowerCase() !== originAddress.toLowerCase()
    )
      throw new DomainError(
        'TREASURY_RECIPIENT',
        'Round-trip proceeds and refunds must return to the derived treasury',
      );
    return { originToken, intermediateToken, originAddress, intermediateAddress };
  }
  private firstTerms(p: Proposal, r: Omit<Route, 'first' | 'second'>): SwapTerms {
    return {
      originAsset: p.originAsset,
      destinationAsset: p.intermediateAsset,
      amount: p.amountAtoms,
      recipient: r.intermediateAddress,
      refundTo: r.originAddress,
      deadline: p.expiresAt,
      slippageBps: p.slippageBps,
    };
  }
  private secondTerms(p: Proposal, r: Omit<Route, 'first' | 'second'>, amount: string): SwapTerms {
    return {
      originAsset: p.intermediateAsset,
      destinationAsset: p.originAsset,
      amount,
      recipient: r.originAddress,
      refundTo: r.intermediateAddress,
      deadline: p.expiresAt,
      slippageBps: p.slippageBps,
    };
  }
  async quote(_cycleId: string, p: Proposal): Promise<Quote> {
    const route = await this.route(p),
      first = await this.oneclick.quote(this.firstTerms(p, route), true);
    const second = await this.oneclick.quote(
      this.secondTerms(p, route, first.quote.minAmountOut),
      true,
    );
    const full = { ...route, first, second };
    const costs =
      BigInt(this.store.config.GAS_COST_BASE_ATOMS) +
      BigInt(this.store.config.LIVE_COST_BUFFER_ATOMS);
    return {
      id: digest(full),
      inputAtoms: p.amountAtoms,
      expectedOutputAtoms: second.quote.amountOut,
      minimumOutputAtoms: second.quote.minAmountOut,
      costsAtoms: costs.toString(),
      expiresAt: new Date(Math.min(Date.parse(p.expiresAt), Date.now() + 120000)).toISOString(),
      routeDigest: digest(full),
      route: full,
    };
  }
  async assess(cycleId: string, p: Proposal, q: Quote) {
    await this.pay(
      cycleId,
      'signal',
      this.store.config.NEAR_SCOUT_ACCOUNT_ID,
      digest({ proposal: p, quote: q }),
      'BRAIN',
    );
    return this.ai.assess(cycleId, p, q);
  }
  private decode(ciphertext: string, id: string): LegPayload {
    return unseal(ciphertext, this.store.config.EVIDENCE_ENCRYPTION_KEY, id) as LegPayload;
  }
  private async save(id: string, payload: LegPayload, status: string, txHash?: string) {
    await this.store.db.liveLeg.update({
      where: { id },
      data: {
        status,
        payloadCiphertext: seal(payload, this.store.config.EVIDENCE_ENCRYPTION_KEY, id),
        ...(txHash ? { txHash } : {}),
      },
    });
  }
  private async prepareLeg(
    cycleId: string,
    leg: number,
    p: Proposal,
    q: Quote,
    terms: SwapTerms,
    minimumOutput: string,
  ): Promise<SignedTransfer> {
    const id = `${cycleId}:${leg}`,
      c = this.store.config;
    let row = await this.store.db.liveLeg.findUnique({ where: { id } }),
      payload: LegPayload;
    if (row) {
      if (row.termsDigest !== digest(terms))
        throw new DomainError('LEG_TERMS_CONFLICT', 'Persisted execution terms differ');
      payload = this.decode(row.payloadCiphertext, id);
      if (payload.signed) return payload.signed;
    } else {
      const quote = await this.oneclick.quote(terms, false);
      if (BigInt(quote.quote.minAmountOut) < BigInt(minimumOutput))
        throw new DomainError(
          'ROUTE_REPRICE',
          'Executable quote no longer meets the assessed minimum',
        );
      const r = q.route as unknown as Route,
        chain = leg === 1 ? p.originChain : p.destinationChain,
        token = leg === 1 ? r.originToken.contractAddress! : 'sol:native';
      const unsigned = await this.wallets.prepare(
        chain,
        token,
        quote.quote.depositAddress!,
        terms.amount,
      );
      const proof = await this.store.db.proof.findFirstOrThrow({
        where: { cycleId, kind: 'NEAR_AI', status: 'VERIFIED' },
      });
      const authorization = this.wallets.authorization(unsigned, {
        cycle_id: id,
        proposal_hash: digest(p),
        route_hash: digest(quote),
        evidence_hash: digest({
          requestHash: proof.requestHash,
          responseHash: proof.responseHash,
          measurement: proof.measurement,
        }),
        amount_atoms: terms.amount,
        budget_atoms: p.amountAtoms,
        expires_at_ns: (BigInt(Date.parse(terms.deadline)) * 1_000_000n).toString(),
        slippage_bps: p.slippageBps,
      });
      const { evmBlock, solanaSlot } = await this.wallets.heads();
      payload = {
        terms,
        quote,
        unsigned,
        authorization,
        beforeBlocks: { evm: evmBlock.toString(), solana: solanaSlot.toString() },
      };
      await this.store.atomic(async (tx) => {
        // One target wallet operation at a time prevents concurrent unsigned EVM nonce allocation.
        // Advisory locks return PostgreSQL void, which Prisma cannot deserialize as a result row.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(78234831)`;
        const active = await tx.liveLeg.findFirst({
          where: { status: { not: 'DONE' }, id: { not: id } },
        });
        if (active)
          throw new DomainError(
            'WALLET_BUSY',
            'Reconcile the outstanding target-chain operation first',
          );
        await tx.liveLeg.create({
          data: {
            id,
            cycleId,
            leg,
            termsDigest: digest(terms),
            status: 'PREPARED',
            payloadCiphertext: seal(payload, c.EVIDENCE_ENCRYPTION_KEY, id),
          },
        });
      });
      row = await this.store.db.liveLeg.findUniqueOrThrow({ where: { id } });
    }
    await this.treasury.authorize(payload.authorization);
    let record = await this.treasury.cycle(id);
    if (record?.status === 'AUTHORIZED') {
      await this.save(id, payload, 'SIGNING');
      // Duplicate NEAR calls cannot produce a second signature: the contract consumes AUTHORIZED once.
      await this.treasury.call(
        'HAND',
        payload.unsigned.authorizationChainId === 0
          ? 'request_solana_signature'
          : 'request_evm_signature',
        { cycle_id: id, ...payload.unsigned.signArgs },
        250_000_000_000_000n,
      );
      record = await this.treasury.cycle(id);
    }
    if (!record?.signature || !['SIGNED', 'SUBMITTED', 'CLOSED'].includes(record.status))
      throw new DomainError(
        'MPC_PENDING',
        'Signature is pending or failed; no replacement authorization is created',
      );
    if (record.payload_hex !== payload.unsigned.payloadHex)
      throw new DomainError(
        'ONCHAIN_PAYLOAD',
        'Contract payload does not match the exact local transaction',
      );
    payload.signed = await this.wallets.finalize(payload.unsigned, JSON.parse(record.signature));
    await this.save(id, payload, 'SIGNED', payload.signed.txHash);
    return payload.signed;
  }
  async prepare(cycleId: string, p: Proposal, q: Quote): Promise<PreparedExecution> {
    const r = q.route as unknown as Route;
    await this.pay(
      cycleId,
      'assessment',
      this.store.config.NEAR_BRAIN_ACCOUNT_ID,
      digest({ proposal: p, quote: q }),
      'HAND',
    );
    const signed = await this.prepareLeg(
      cycleId,
      1,
      p,
      q,
      this.firstTerms(p, r),
      r.first.quote.minAmountOut,
    );
    return {
      id: `${cycleId}:1`,
      chainId: signed.chainId,
      txHash: signed.txHash,
      operation: 'SWAP_DEPOSIT',
      asset: p.originAsset,
      amountAtoms: p.amountAtoms,
      data: { legId: `${cycleId}:1` },
    };
  }
  async broadcast(execution: PreparedExecution): Promise<void> {
    const row = await this.store.db.liveLeg.findUniqueOrThrow({ where: { id: execution.id } }),
      payload = this.decode(row.payloadCiphertext, row.id);
    if (!payload.signed || payload.signed.txHash !== execution.txHash)
      throw new DomainError('SIGNED_MATERIAL', 'No matching durable signed transaction');
    if (Date.parse(payload.terms.deadline) <= Date.now() + 10000)
      throw new DomainError(
        'DEPOSIT_DEADLINE',
        'Do not broadcast a signed deposit near or after its provider deadline',
      );
    const policy = await this.store.db.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } });
    if (
      policy.paused ||
      !policy.allowedAssets.includes(payload.terms.originAsset) ||
      !policy.allowedAssets.includes(payload.terms.destinationAsset)
    )
      throw new DomainError('POLICY_CHANGED', 'Current policy blocks this broadcast');
    const now = new Date(),
      cutoff = new Date(now.getTime() - this.store.config.REBROADCAST_INTERVAL_MS);
    const attempt = await this.store.db.liveLeg.updateMany({
      where: {
        id: row.id,
        status: { not: 'DONE' },
        broadcastAttempts: { lt: this.store.config.MAX_BROADCAST_ATTEMPTS },
        OR: [{ lastBroadcastAt: null }, { lastBroadcastAt: { lte: cutoff } }],
      },
      data: {
        broadcastAttempts: { increment: 1 },
        lastBroadcastAt: now,
        lastBroadcastError: null,
        status: 'BROADCASTING',
      },
    });
    if (attempt.count !== 1)
      throw new DomainError(
        'BROADCAST_RETRY_HELD',
        'Broadcast cooldown, retry budget or completed operation prevents another send',
      );
    try {
      const record = await this.treasury.cycle(row.id);
      if (!record || !['SIGNED', 'SUBMITTED'].includes(record.status))
        throw new DomainError(
          'ONCHAIN_SUBMISSION',
          'On-chain authorization is not ready for this deposit',
        );
      if (record.tx_hash && record.tx_hash !== execution.txHash)
        throw new DomainError(
          'ONCHAIN_SUBMISSION_CONFLICT',
          'On-chain authorization identifies a different transaction',
        );
      if (!record.tx_hash)
        await this.treasury.call('HAND', 'record_submission', {
          cycle_id: row.id,
          tx_hash: execution.txHash,
        });
      // Every retry reuses these exact durable bytes, never a new signature, nonce or transaction.
      await this.wallets.broadcast(payload.signed);
      await this.save(row.id, payload, 'BROADCAST', execution.txHash);
    } catch (e) {
      await this.store.db.liveLeg.update({
        where: { id: row.id },
        data: {
          lastBroadcastError: e instanceof DomainError ? e.code : 'BROADCAST_OUTCOME_UNKNOWN',
        },
      });
      throw e;
    }
    // Notification is an optimization. Polling remains the authority if the notification fails.
    await this.oneclick
      .notify(payload.quote.quote.depositAddress!, execution.txHash)
      .catch(() => undefined);
  }
  private async retryBroadcast(
    row: { id: string; status: string; broadcastAttempts: number; lastBroadcastAt: Date | null },
    payload: LegPayload,
  ): Promise<void> {
    if (
      row.status === 'DONE' ||
      row.broadcastAttempts >= this.store.config.MAX_BROADCAST_ATTEMPTS ||
      !payload.signed
    )
      return;
    if (
      row.lastBroadcastAt &&
      Date.now() - row.lastBroadcastAt.getTime() < this.store.config.REBROADCAST_INTERVAL_MS
    )
      return;
    if (Date.parse(payload.terms.deadline) <= Date.now() + 10000) return;
    await this.broadcast({
      id: row.id,
      chainId: payload.signed.chainId,
      txHash: payload.signed.txHash,
      operation: 'SWAP_DEPOSIT',
      asset: payload.terms.originAsset,
      amountAtoms: payload.terms.amount,
      data: {},
    }).catch(() => undefined);
  }
  private async finalizeAuthorization(
    id: string,
    reconciliationHash: string,
    pnl: string,
  ): Promise<void> {
    const record = await this.treasury.cycle(id);
    if (record?.status === 'CLOSED') {
      if (record.reconciliation_hash !== reconciliationHash || record.realized_pnl_atoms !== pnl)
        throw new DomainError(
          'FINALIZATION_CONFLICT',
          'Existing on-chain reconciliation identifies different facts',
        );
      return;
    }
    await this.treasury.call('ACCOUNTANT', 'finalize_cycle', {
      cycle_id: id,
      reconciliation_hash: reconciliationHash,
      realized_pnl_atoms: pnl,
    });
  }
  private async observe(
    id: string,
  ): Promise<{ payload: LegPayload; status: string; amount: string }> {
    const row = await this.store.db.liveLeg.findUniqueOrThrow({ where: { id } }),
      payload = this.decode(row.payloadCiphertext, id);
    if (!payload.signed) throw new DomainError('LEG_UNSIGNED', 'Cannot reconcile an unsigned leg');
    const confirmation = await this.wallets.confirmed(payload.signed);
    if (!confirmation.confirmed) {
      await this.retryBroadcast(row, payload);
      return { payload, status: 'PENDING', amount: '0' };
    }
    if (confirmation.failed)
      throw new DomainError(
        'DEPOSIT_REVERTED',
        'Deposit reverted; reconciliation is required before releasing reservations',
      );
    const result = await this.oneclick.status(payload.quote.quote.depositAddress!);
    if (digest(result.quoteResponse) !== digest(payload.quote))
      throw new DomainError('SETTLEMENT_QUOTE', 'Status quote differs from the funded quote');
    payload.nativeFeeAtoms = confirmation.nativeFeeAtoms;
    payload.statusEvidence = result;
    if (result.status !== 'SUCCESS' && result.status !== 'REFUNDED')
      return { payload, status: 'PENDING', amount: '0' };
    const amount =
      result.status === 'SUCCESS'
        ? result.swapDetails.amountOut
        : result.swapDetails.refundedAmount;
    if (!amount)
      throw new DomainError(
        'SETTLEMENT_AMOUNT',
        'Provider has not published settled atomic amounts',
      );
    // Provider evidence is corroborated by final target-chain transaction inclusion; never a quote alone.
    const refunded = result.status === 'REFUNDED';
    const receiptHashes = (
      refunded
        ? result.swapDetails.originChainTxHashes
        : result.swapDetails.destinationChainTxHashes
    ).map((t) => t.hash);
    if (!receiptHashes.length)
      throw new DomainError(
        'DESTINATION_EVIDENCE',
        'No destination transaction evidence is available',
      );
    const cycle = await this.store.getCycle(row.cycleId),
      proposal = cycle.proposal as unknown as Proposal,
      route = (cycle.quote as unknown as Quote).route as unknown as Route;
    const destination = refunded
      ? payload.unsigned.chainId
      : row.leg === 1
        ? proposal.destinationChain
        : proposal.originChain;
    const token = destination.startsWith('eip155:')
      ? route.originToken.contractAddress!
      : 'sol:native';
    const recipient = refunded ? payload.terms.refundTo : payload.terms.recipient;
    if (!payload.beforeBlocks)
      throw new DomainError(
        'MISSING_CHAIN_BOUNDARY',
        'A legacy operation lacks a committed receipt boundary; manual reconciliation is required',
      );
    const incoming = await this.wallets.verifyIncoming(
      destination,
      token,
      recipient,
      amount,
      receiptHashes,
      BigInt(
        destination.startsWith('eip155:') ? payload.beforeBlocks.evm : payload.beforeBlocks.solana,
      ),
    );
    if (!incoming.verified) return { payload, status: 'PENDING', amount: '0' };
    await this.store.atomic(async (tx) => {
      for (const transfer of incoming.transfers) {
        const operation = 'INTENTS_RECEIPT',
          asset = refunded ? payload.terms.originAsset : payload.terms.destinationAsset;
        const existing = await tx.chainTransaction.findUnique({
          where: {
            chainId_txHash_operation: { chainId: destination, txHash: transfer.txHash, operation },
          },
        });
        if (existing) {
          if (
            existing.cycleId !== row.cycleId ||
            existing.asset !== asset ||
            existing.amountAtoms !== transfer.amountAtoms
          )
            throw new DomainError(
              'RECEIPT_REUSE',
              'Incoming transfer evidence already belongs to another accounting claim',
            );
          continue;
        }
        const data = {
          cycleId: row.cycleId,
          chainId: destination,
          txHash: transfer.txHash,
          operation,
          asset,
          amountAtoms: transfer.amountAtoms,
          status: 'FINALIZED',
        };
        await tx.chainTransaction.create({ data });
        await this.store.event(tx, 'new_transaction', data, row.cycleId);
      }
    });
    await this.save(id, payload, 'DONE');
    return { payload, status: result.status, amount };
  }
  async settle(
    cycleId: string,
    p: Proposal,
    q: Quote,
    _execution: PreparedExecution,
  ): Promise<Settlement> {
    const first = await this.observe(`${cycleId}:1`);
    if (first.status === 'PENDING') return pending({ leg: 1 });
    if (first.status === 'REFUNDED') {
      if (BigInt(first.amount) > BigInt(p.amountAtoms))
        throw new DomainError(
          'UNEXPECTED_REFUND_AMOUNT',
          'An excess refund requires explicit accounting classification',
        );
      const evidenceHash = digest({
        kind: 'FIRST_LEG_REFUND',
        cycleId,
        depositTxHash: first.payload.signed!.txHash,
        quoteDigest: digest(first.payload.quote),
        refundedAtoms: first.amount,
        nativeFeeAtoms: first.payload.nativeFeeAtoms,
      });
      await this.finalizeAuthorization(
        `${cycleId}:1`,
        evidenceHash,
        (BigInt(first.amount) - BigInt(p.amountAtoms)).toString(),
      );
      return {
        status: 'REFUNDED',
        receivedAtoms: first.amount,
        feesAtoms: '0',
        transactions: this.transactions(first.payload, p.originAsset),
        evidence: {
          first: first.payload.statusEvidence,
          nativeFees: [{ chainId: p.originChain, atoms: first.payload.nativeFeeAtoms }],
          feeValuation: 'UNVALUED_NATIVE_FEES',
          reconciliationHash: evidenceHash,
        },
      };
    }
    const r = q.route as unknown as Route;
    const policy = await this.store.db.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } });
    if (policy.paused) return pending({ reason: 'TREASURY_PAUSED', leg: 2 });
    let second = await this.store.db.liveLeg.findUnique({ where: { id: `${cycleId}:2` } });
    if (!second?.txHash) {
      // Return pricing is refreshed after confirmed receipt. Failure preserves intermediate assets and holds the reserve.
      // The round trip is asynchronous: the preview never guarantees a future return price.
      const signed = await this.prepareLeg(
        cycleId,
        2,
        p,
        q,
        this.secondTerms(p, r, first.amount),
        q.minimumOutputAtoms,
      );
      const ex: PreparedExecution = {
        id: `${cycleId}:2`,
        chainId: signed.chainId,
        txHash: signed.txHash,
        operation: 'RETURN_DEPOSIT',
        asset: p.intermediateAsset,
        amountAtoms: first.amount,
        data: {},
      };
      await this.broadcast(ex);
      return pending({ leg: 2 });
    }
    // A crash after signing but before broadcast can safely resend the exact bytes once reconciled as absent.
    if (second.status === 'SIGNED') {
      const payload = this.decode(second.payloadCiphertext, second.id);
      await this.broadcast({
        id: second.id,
        chainId: payload.signed!.chainId,
        txHash: payload.signed!.txHash,
        operation: 'RETURN_DEPOSIT',
        asset: p.intermediateAsset,
        amountAtoms: first.amount,
        data: {},
      });
      return pending({ leg: 2 });
    }
    const returned = await this.observe(`${cycleId}:2`);
    if (returned.status !== 'SUCCESS')
      return pending({
        leg: 2,
        status: returned.status,
        reason:
          returned.status === 'REFUNDED'
            ? 'Intermediate SOL remains in the treasury; operator reconciliation is required'
            : undefined,
      });
    return {
      status: 'SUCCESS',
      receivedAtoms: returned.amount,
      feesAtoms: '0',
      transactions: [
        ...this.transactions(first.payload, p.originAsset),
        ...this.transactions(returned.payload, p.intermediateAsset),
      ],
      evidence: {
        first: first.payload.statusEvidence,
        second: returned.payload.statusEvidence,
        nativeFees: [
          { chainId: p.originChain, atoms: first.payload.nativeFeeAtoms },
          { chainId: p.destinationChain, atoms: returned.payload.nativeFeeAtoms },
        ],
        feeValuation: 'UNVALUED_NATIVE_FEES',
        asyncPriceRisk: true,
      },
    };
  }
  private transactions(payload: LegPayload, asset: string): Settlement['transactions'] {
    return [
      {
        chainId: payload.signed!.chainId,
        txHash: payload.signed!.txHash,
        operation: 'SWAP_DEPOSIT',
        asset,
        amountAtoms: payload.terms.amount,
        status: 'FINALIZED',
      },
    ];
  }
  async receipt(
    cycleId: string,
    evidence: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cycle = await this.store.getCycle(cycleId),
      p = cycle.proposal as unknown as Proposal,
      settlement = cycle.settlement as unknown as Settlement;
    const gross = BigInt(settlement.receivedAtoms) - BigInt(p.amountAtoms);
    // Native gas and compute costs must be fully valued before claiming net profit or issuing economic rights.
    const usage = await this.store.db.computeUsage.findMany({ where: { cycleId } });
    const compute =
      (usage.reduce((sum, v) => sum + BigInt(v.costUsdMicros), 0n) *
        10n ** BigInt(this.store.config.BASE_DECIMALS)) /
      1_000_000n;
    const basis = await this.store.db.costBasis.findUnique({ where: { cycleId } });
    if (
      basis &&
      (basis.settlementDigest !== digest(settlement) ||
        BigInt(basis.inferenceCostUsdMicros) !==
          usage.reduce((sum, v) => sum + BigInt(v.costUsdMicros), 0n))
    )
      throw new DomainError(
        'COST_BASIS_STALE',
        'Approved costs no longer match the settlement and metered usage',
      );
    if (this.store.config.NFT_SHARE_BPS > 0 && !basis)
      throw new DomainError(
        'COST_BASIS_REQUIRED',
        'Revenue-rights minting awaits accountant approval of complete costs',
      );
    const conservativePnl = basis
      ? gross - totalApprovedCost(basis)
      : gross -
        compute -
        BigInt(this.store.config.GAS_COST_BASE_ATOMS) -
        BigInt(this.store.config.LIVE_COST_BUFFER_ATOMS);
    for (const leg of [1, 2])
      await this.finalizeAuthorization(
        `${cycleId}:${leg}`,
        digest({ ...evidence, costBasisDigest: basis?.termsDigest ?? null }),
        leg === 1 ? conservativePnl.toString() : '0',
      );
    if (conservativePnl <= 0n)
      return {
        mintedOnChain: false,
        reason: 'NO_POSITIVE_CONSERVATIVE_PNL',
        grossPnlAtoms: gross.toString(),
        conservativePnlAtoms: conservativePnl.toString(),
        nativeFeesValued: !!basis,
        costBasisTrust: basis ? 'ACCOUNTANT_APPROVED' : 'CONFIGURED_BUFFERS',
      };
    const token = await this.treasury.call('ACCOUNTANT', 'mint_proof_nft', {
      cycle_id: `${cycleId}:1`,
      receiver_id: this.store.config.NFT_RECEIVER_ID,
      share_bps: this.store.config.NFT_SHARE_BPS,
    });
    return {
      mintedOnChain: true,
      token,
      contractId: this.store.config.NEAR_CONTRACT_ID,
      grossPnlAtoms: gross.toString(),
      conservativePnlAtoms: conservativePnl.toString(),
      nativeFeesValued: !!basis,
      costBasisTrust: basis ? 'ACCOUNTANT_APPROVED' : 'CONFIGURED_BUFFERS',
      costBasisDigest: basis?.termsDigest ?? null,
      accountantReported: true,
    };
  }
}
