#!/usr/bin/env bash
set -euo pipefail
export CARGO_TARGET_DIR="$PWD/contracts/treasury/target"
export RUSTFLAGS='--cfg near -C target-cpu=mvp'
cargo build --manifest-path contracts/mpc-mock/Cargo.toml --target wasm32-unknown-unknown --release --locked
