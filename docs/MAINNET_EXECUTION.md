# Funded mainnet execution preparation

This runbook prepares the first funded Base USDC → native Solana SOL → Base USDC round trip supported by the current live provider. It does not establish that a profitable route exists. Existing policy, TEE, compute-credit, signature and reconciliation gates remain required.

The owner account and funding budget have not been selected. No mainnet deployment, account creation, funding, paid inference, MPC signature request or swap has been performed during this preparation. The hosted PAPER service remains separate from funded operation.

The [captured release preparation](../artifacts/mainnet-release-preparation.json) records the actual mainnet observations, built artifact, 39 backend unit tests, 12 Rust tests and 10 sandbox checks. Its refreshed signed dry quotes return 9.84244 USDC conservatively from a 10-USDC input before additional operating costs; this route was rejected for live execution.

## Release and read-only inspection

```sh
npm run contract:build
npm run live:inspect
```

The inspector reads mainnet status, a final block, its protocol configuration, the MPC account and any configured NEAR role accounts. All account/configuration observations are pinned to that final block. It records the WASM SHA-256 and NEAR code hash, flags a configured treasury whose code differs, and calculates the code-storage lock lower bound using integer arithmetic. It cannot sign, deploy, fund, start workers or approve a spending budget. An existing MPC contract is not proof that this treasury has obtained a valid MPC signature.

The detailed report is saved at `.data/live-execution/release-inspection.json`. RPC endpoints/credentials and private keys are not included. An HTTPS mainnet RPC can be selected with `--rpc`. Once the dedicated owner is chosen, inspect it without providing its key:

```sh
npm run live:inspect -- --owner YOUR_DEDICATED_OWNER.near
```

Set only the selected role account IDs locally to inspect those accounts. Do not copy unrelated wallet credentials. A missing or mismatching account is an observation, not authorization to create or overwrite it.

## Funding worksheet

The rebuilt treasury currently occupies **579,388 bytes**. At the observed mainnet storage price of **10,000,000,000,000,000,000 yoctoNEAR per byte**, code alone locks **5.79388 NEAR**. Refresh the inspector before budgeting; a different WASM or protocol price changes the amount. This is locked capital, not a burned deployment fee. Account/key storage, initial and growing contract state, operational reserves and gas are additional.

Record the following decisions before constructing signed transactions:

| Allocation                | Required decision                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Owner                     | Dedicated mainnet account ID and offline recovery/signing method                   |
| Treasury                  | Account ID, code/state storage allocation and uncommitted native reserve           |
| Brain / Hand / Accountant | Account IDs, native gas allocations and per-key gas allowances                     |
| Scout                     | Recipient account ID; no Scout signing key is required by the current runtime      |
| Intents service payments  | Dedicated registered Brain/Hand keys and each payer's wNEAR allocation             |
| Trading capital           | Explicit USDC principal, maximum per trade and total daily authorization budget    |
| Base gas                  | Native ETH allocation at the derived Base address                                  |
| Solana gas                | Native SOL fee reserve at the derived Solana address, separate from trade proceeds |
| Receipt                   | Receiver account; zero revenue rights for the first credential receipt             |
| Overall ceilings          | Maximum total deployment/funding spend and maximum acceptable execution loss       |

Both legs consume authorization budget. The contract's daily base-asset ceiling must cover both, while raw USDC and SOL caps remain independent. Gas allowances are limits on the role accounts' balances, not extra funds automatically supplied by a key. A deposit of USDC on NEAR does not automatically provision Base USDC, ETH, SOL, NEAR storage or Intents balances.

## Owner-signed deployment sequence

1. Select dedicated owner, treasury and role account IDs. Check each against mainnet. Create only new intended accounts with explicitly allocated NEAR funding. Preserve offline recovery access; never place the owner's recovery key on Render or in the backend environment.
2. Review the exact initializer from [Operations](OPERATIONS.md#build-and-initialize-the-treasury): owner, Brain, Hand, accountant, `mpc=v1.signer`, immutable derivation path and policy. Resolve the actual Base USDC registry ID/address and native-SOL metadata. Replace all example values and size independent token/base limits from the approved budget.
3. Deploy **only** the treasury WASM and initialize in the same deployment transaction. Use the new treasury account's offline deployment authority. Pause it through the configured owner before enabling role workers or funding derived wallets. Do not deploy the sandbox MPC mock.
4. Capture the deployment/initialization transaction hashes, initializer and WASM hash. Run `live:inspect` with `NEAR_CONTRACT_ID` set and require a matching treasury code hash. Read `get_signing_identity`, `get_policy` and `check_metabolism`; match the immutable predecessor/path/MPC identity and intended limits. Verify the role IDs against the initializer transaction and inspect the access keys on each role account.
5. Install dedicated function-call keys with bounded allowances. Treasury receivers/methods: Brain `authorize_cycle`; Hand `request_evm_signature`, `request_solana_signature`, `record_submission`; accountant `finalize_cycle`, `mint_proof_nft`. Use separate Brain/Hand keys scoped to `intents.near` and `execute_intents` for the service rail. Keep each role's offline recovery authority separate from runtime credentials.
6. From each named payer account's offline authority, register its dedicated Intents public key with `add_public_key` (1 yoctoNEAR attached). Complete the required wNEAR storage/deposit steps and verify each payer's `nep141:wrap.near` balance on `intents.near`. Removing a NEAR access key does not revoke its Intents registration.
7. Derive EVM/Solana addresses using the deployed **treasury account** plus the reviewed path and mainnet MPC service. Use the existing `ChainWallets.address` implementation. Verify the Base chain ID and Solana mainnet genesis before funding. Record exact addresses, chain, token contract and decimals in the owner-reviewed funding sheet. Only then send the approved principal and native-gas allocations from separately authorized funding wallets.

The CLI installed during preparation is `near-cli-rs 0.30.1`; discover full transaction syntax with `--help` before use. Account names, recovery public keys and approved allocations are still needed to produce the final owner-signable transaction bundle.

## First live cycle and evidence

Use a dedicated LIVE database/environment; retain the PAPER deployment. Supply the remaining settings reported by `npm run live:preflight`, approved TEE measurements and provider balance access. Disable chaos controls and use `NFT_SHARE_BPS=0` for the first receipt. Initialization of database policy happens once; verify its persisted revision and values as well as the independent on-chain policy.

Create an allowlisted `SCOUT_ROUTES_FILE` using the supported Base USDC/native-SOL route, actual registry IDs, `originChain=eip155:8453`, `destinationChain=solana:mainnet`, and the derived EVM treasury as both final recipient/refund address. Scout supplies expiry. An empty route file or missing path does not create autonomous opportunities.

Before enabling the worker, verify native reserves, confirmed principal, service balances, key receiver/method scopes, model/billing access and both policy layers. Have the owner unpause the verified contract only when that preparation is complete. Enable LIVE explicitly in the dedicated environment. The scanner must reject a quote that fails the net-profit floor. If no acceptable route exists, record that result; do not lower controls to force a swap.

For the admitted cycle, retain both signed quote commitments, the two authorization IDs, NEAR MPC-request transactions/results, both target-chain deposit transactions, 1Click settlement evidence and confirmed incoming balances. Verify that the sender recovered from each signature matches its recorded derived address. Preserve exact hashes and amounts through retries. An expired quote, stale blockhash, unknown outcome, or inadequate return quote follows the existing held/reconciliation path rather than creating another payment.

Finally, save the cycle evidence, actual gas/service/compute charges, journal references and closing balances. Label external funding separately from trading results, and distinguish actual execution from profitability. A completed swap alone does not establish the profit-to-compute purchase loop.

References: [Chain Signatures and mainnet signer](https://docs.near.org/chain-abstraction/chain-signatures/implementation), [storage staking](https://docs.near.org/smart-contracts/anatomy/storage), [Intents key registration](https://docs.near-intents.org/integration/verifier-contract/account-abstraction), [application operations](OPERATIONS.md).
