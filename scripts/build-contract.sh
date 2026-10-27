#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
# near-sdk >=5.27 requires the on-chain host-function path explicitly.
export RUSTFLAGS='--cfg near -C target-cpu=mvp'
cargo build --manifest-path contracts/treasury/Cargo.toml --target wasm32-unknown-unknown --release --locked
cp contracts/treasury/target/wasm32-unknown-unknown/release/symbiochain_treasury.wasm artifacts/symbiochain_treasury.wasm
sha256sum artifacts/symbiochain_treasury.wasm
