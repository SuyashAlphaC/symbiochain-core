import { z } from 'zod';
import type {
  QuoteRequest,
  QuoteResponse,
  GetExecutionStatusResponse,
  TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { DomainError, atoms, digest } from '../domain.js';
import type { Config } from '../config.js';
import { httpJson, type Fetch } from './http.js';

export interface SwapTerms {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  deadline: string;
  slippageBps: number;
}
const quoteSchema = z
  .object({
    correlationId: z.string(),
    timestamp: z.iso.datetime(),
    signature: z.string().min(1),
    quoteRequest: z.record(z.string(), z.unknown()),
    quote: z
      .object({
        amountIn: atoms,
        amountOut: atoms,
        minAmountOut: atoms,
        depositAddress: z.string().optional(),
        depositMemo: z.string().optional(),
        deadline: z.iso.datetime().optional(),
        timeEstimate: z.number().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
export class OneClickClient {
  constructor(
    private readonly config: Config,
    private readonly transport: Fetch = fetch,
  ) {}
  private headers() {
    return {
      ...(this.config.ONECLICK_JWT ? { authorization: `Bearer ${this.config.ONECLICK_JWT}` } : {}),
      'content-type': 'application/json',
    };
  }
  async tokens(): Promise<TokenResponse[]> {
    const raw = await httpJson(
      new URL('/v0/tokens', this.config.ONECLICK_API_BASE_URL),
      { headers: this.headers() },
      this.transport,
    );
    return z
      .array(
        z
          .object({
            assetId: z.string(),
            decimals: z.number().int().min(0).max(24),
            blockchain: z.string(),
            symbol: z.string(),
            price: z.number().nonnegative(),
            priceUpdatedAt: z.iso.datetime(),
            contractAddress: z.string().optional(),
          })
          .passthrough(),
      )
      .parse(raw) as TokenResponse[];
  }
  async quote(t: SwapTerms, dry: boolean): Promise<QuoteResponse> {
    const request = {
      dry,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: t.slippageBps,
      originAsset: t.originAsset,
      destinationAsset: t.destinationAsset,
      depositType: 'ORIGIN_CHAIN',
      amount: t.amount,
      recipient: t.recipient,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: t.refundTo,
      refundType: 'ORIGIN_CHAIN',
      deadline: t.deadline,
    } as QuoteRequest;
    const raw = quoteSchema.parse(
      await httpJson(
        new URL('/v0/quote', this.config.ONECLICK_API_BASE_URL),
        { method: 'POST', headers: this.headers(), body: JSON.stringify(request) },
        this.transport,
      ),
    );
    for (const [key, value] of Object.entries(request))
      if (digest(raw.quoteRequest[key]) !== digest(value))
        throw new DomainError('QUOTE_TERMS', 'Provider quote does not echo requested terms');
    if (
      !verifyQuoteSignature(
        raw as unknown as QuoteResponse,
        this.config.ONECLICK_MANAGER_PUBLIC_KEY,
      )
    )
      throw new DomainError('QUOTE_SIGNATURE', '1Click quote signature is invalid');
    if (
      raw.quote.amountIn !== t.amount ||
      BigInt(raw.quote.minAmountOut) > BigInt(raw.quote.amountOut)
    )
      throw new DomainError('QUOTE_AMOUNTS', 'Unexpected quote amounts');
    if (!dry && (!raw.quote.depositAddress || raw.quote.depositMemo))
      throw new DomainError('DEPOSIT_FORMAT', 'Expected a simple deposit address without a memo');
    if (!dry && (!raw.quote.deadline || Date.parse(raw.quote.deadline) <= Date.now() + 30000))
      throw new DomainError('QUOTE_EXPIRED', 'Deposit quote has insufficient lifetime');
    return raw as unknown as QuoteResponse;
  }
  async status(address: string): Promise<GetExecutionStatusResponse> {
    const url = new URL('/v0/status', this.config.ONECLICK_API_BASE_URL);
    url.searchParams.set('depositAddress', address);
    const data = z
      .object({
        status: z.enum([
          'KNOWN_DEPOSIT_TX',
          'PENDING_DEPOSIT',
          'INCOMPLETE_DEPOSIT',
          'PROCESSING',
          'SUCCESS',
          'REFUNDED',
          'FAILED',
        ]),
        quoteResponse: quoteSchema,
        swapDetails: z
          .object({
            amountIn: atoms.optional(),
            amountOut: atoms.optional(),
            refundedAmount: atoms.optional(),
            originChainTxHashes: z.array(z.object({ hash: z.string(), explorerUrl: z.string() })),
            destinationChainTxHashes: z.array(
              z.object({ hash: z.string(), explorerUrl: z.string() }),
            ),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(await httpJson(url, { headers: this.headers() }, this.transport));
    if (data.quoteResponse.quote.depositAddress !== address)
      throw new DomainError('SETTLEMENT_BINDING', 'Status belongs to another deposit');
    if (
      !verifyQuoteSignature(
        data.quoteResponse as unknown as QuoteResponse,
        this.config.ONECLICK_MANAGER_PUBLIC_KEY,
      )
    )
      throw new DomainError('QUOTE_SIGNATURE', 'Status carries an invalid 1Click quote signature');
    return data as unknown as GetExecutionStatusResponse;
  }
  async notify(address: string, txHash: string): Promise<void> {
    await httpJson(
      new URL('/v0/deposit/submit', this.config.ONECLICK_API_BASE_URL),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ depositAddress: address, txHash }),
      },
      this.transport,
    );
  }
}
