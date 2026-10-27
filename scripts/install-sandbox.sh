#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)-$(uname -m)" = 'Linux-x86_64' || { echo 'This pinned sandbox installer supports Linux x86_64.'; exit 1; }
mkdir -p .data/bin
curl -fsSL --max-time 120 'https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.13.4/near-sandbox.tar.gz' -o .data/bin/near-sandbox.tar.gz
echo '5690a4635172263cf026683f75965cac09dd916912584f12709974fed620163f  .data/bin/near-sandbox.tar.gz' | sha256sum --check
tar -xzf .data/bin/near-sandbox.tar.gz -C .data/bin
.data/bin/Linux-x86_64/near-sandbox --version
