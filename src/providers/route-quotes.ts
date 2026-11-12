import type { QuoteResponse, TokenResponse } from '@defuse-protocol/one-click-sdk-typescript';
import type { Config } from '../config.js';
import { DomainError, digest, type Proposal, type Quote } from '../domain.js';
import type { OneClickClient, SwapTerms } from './oneclick.js';
import type { ChainWallets } from './wallets.js';

export interface Route {
  first: QuoteResponse;
  second: QuoteResponse;
  originToken: TokenResponse;
  intermediateToken: TokenResponse;
  originAddress: string;
  intermediateAddress: string;
}
/** Read-only quote port. It has no signing, billing or broadcast capability. */
export class RoundTripQuotes {
  constructor(
    readonly config: Config,
    readonly oneclick: Pick<OneClickClient, 'tokens' | 'quote'>,
    readonly wallets: Pick<ChainWallets, 'address'>,
  ) {}
  async route(p: Proposal): Promise<Omit<Route, 'first' | 'second'>> {
    const c = this.config,
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
  firstTerms(p: Proposal, r: Omit<Route, 'first' | 'second'>): SwapTerms {
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
  secondTerms(p: Proposal, r: Omit<Route, 'first' | 'second'>, amount: string): SwapTerms {
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
  async quote(p: Proposal): Promise<Quote> {
    const route = await this.route(p),
      first = await this.oneclick.quote(this.firstTerms(p, route), true);
    const second = await this.oneclick.quote(
      this.secondTerms(p, route, first.quote.minAmountOut),
      true,
    );
    const full = { ...route, first, second };
    const costs =
      BigInt(this.config.GAS_COST_BASE_ATOMS) + BigInt(this.config.LIVE_COST_BUFFER_ATOMS);
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
}
