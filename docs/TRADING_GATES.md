# Trading admission and diagnostic evidence

The 10-USDC preview returning 9.840294 USDC is correctly rejected: its conservative gross loss is 0.159706 USDC. With the configured 0.20-USDC preview cost allowance, admission net is -0.359706 USDC. The 0.01-USDC profit floor requires at least 10.21 USDC returned, a 0.369706-USDC shortfall. This allowance is a configured estimate, not a complete realized cost basis.

The current strategy requests an immediate same-aggregator round trip. Buying and immediately selling through the same router does not establish an independent arbitrage edge. Two indicative quotes are not an atomic execution guarantee; the reverse leg must be requoted after the first settles. Signed quotes authenticate the quoted terms, not their profitability.

`minimumOutputAtoms` incorporates slippage protection. Slippage bounds are not charged fees. The reverse admission preview uses the first leg's minimum output, then the second leg's minimum output. Diagnostics separately quote the first leg's larger quoted output to show whether the route would still lose before both protective bounds. That larger diagnostic result never replaces the conservative guard.

Run these read-only probes with the existing partner JWT:

```sh
npm run probe:market
npm run probe:market -- --amount-atoms 10000000 --slippage-bps 10
npm run probe:market -- --amount-atoms 100000000 --slippage-bps 50
```

Amounts are USDC atomic units (six decimals). Optional `--chain` accepts `base`, `eth`, `arbitrum`, or `optimism`; it does not change the runtime's approved scouting routes. Probes use throwaway unfunded addresses, signed `dry: true` quotes and no deposit requests. They cannot purchase inference, create a cycle, request Chain Signatures or submit a trade. Raw quotes stay in ignored `.data/trading-gates/`. The [sanitized evidence](../artifacts/trading-gates-verification.json) records three actual authenticated probes, all unprofitable, with full admission arithmetic.

Rejected discovered cycles now retain their quote and a `profitCheck` decision explaining principal, conservative return, preview allowance, floor and shortfall. This is available through the existing authenticated cycle API. A regression exercises the LIVE provider branch using locally signed quote fixtures and verifies rejection before inference, payments, reservations, signing or broadcast. Fixture tests are not mainnet execution evidence.

The response to a losing route is to skip it and wait for a real executable opportunity. Increasing size or reducing slippage does not manufacture economic value. An independent venue spread, a compensated service, or inventory-based fulfillment would require its own strategy implementation and economic validation. Internal agent transfers and grant credits are not external revenue.

Funded mainnet execution remains disabled until the owner account and explicit spending limits are set, wallets/contracts are prepared and all inference/deployment gates pass. The user deferred those funding choices. No weakening of the profit floor, simulated profit or mainnet loss trade is part of this change.
