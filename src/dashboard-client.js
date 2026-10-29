const $ = (id) => document.getElementById(id);
let token = '',
  capabilities = null,
  snapshot = null,
  selected = null,
  economics = null;
let socket = null,
  cursor = '0',
  reconnectTimer = null,
  refreshTimer = null,
  busy = false;
let refreshPending = false,
  connecting = false;
const seen = new Set();
const costForm = $('cost-form');
const notice = (message, error = false) => {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
};
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const money = (value) => {
  if (value === null || value === undefined) return '—';
  const amount = BigInt(value),
    decimals = snapshot?.baseDecimals ?? 6,
    scale = 10n ** BigInt(decimals);
  const abs = amount < 0n ? -amount : amount;
  const fraction = (abs % scale).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `${amount < 0n ? '−' : ''}${abs / scale}${fraction ? `.${fraction}` : ''}`;
};
async function api(path, method = 'GET', body, key) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error ?? `HTTP ${response.status}`);
  return result;
}
function action(button, work) {
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await work();
      await refresh();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      applyAccess();
    }
  });
}
function applyAccess() {
  for (const button of document.querySelectorAll('[data-admin]'))
    button.disabled = busy || !capabilities?.admin;
  $('new-cycle').hidden = capabilities?.mode !== 'PAPER';
  $('crash-worker').disabled =
    busy || !capabilities?.admin || !capabilities.crashDemoEnabled || !selected;
  $('cancel-crash').disabled = busy || !capabilities?.admin || !capabilities.crashDemoEnabled;
  $('fault-availability').textContent = capabilities?.crashDemoEnabled
    ? 'PAPER crash controls enabled. All three lanes share this worker process.'
    : 'Crash controls are disabled for this runtime.';
  $('cost-fields').disabled =
    busy ||
    !capabilities?.admin ||
    !selected ||
    economics?.status !== 'AWAITING_COST_APPROVAL' ||
    $('cycle-state').textContent !== 'RECONCILED';
  $('prefill-paper-costs').hidden = capabilities?.mode !== 'PAPER';
}
function renderAgents(workers) {
  $('agents').replaceChildren();
  const names = {
    SCOUT: ['01 / EYE', 'Scout', 'Finds approved opportunities and commits their terms.'],
    BRAIN: [
      '02 / JUDGMENT',
      'Brain',
      'Assesses the proposal within deterministic spending limits.',
    ],
    HAND: ['03 / EXECUTION', 'Hand', 'Executes, reconciles and records the resulting receipt.'],
  };
  for (const worker of workers) {
    const [number, name, description] = names[worker.role];
    const age = worker.heartbeat
      ? Math.max(0, Math.round((Date.now() - Date.parse(worker.heartbeat)) / 1000))
      : null;
    const health = worker.paused ? 'PAUSED' : age !== null && age < 30 ? 'HEALTHY' : 'STALE';
    const card = element('article', undefined, 'agent');
    const top = element('div', undefined, 'agent-top');
    top.append(
      element('span', number),
      element('span', health, health === 'HEALTHY' ? 'healthy' : 'stale'),
    );
    const bottom = element('div', undefined, 'agent-bottom');
    const button = element('button', worker.paused ? 'Resume agent' : 'Pause agent', 'secondary');
    button.dataset.admin = '';
    button.dataset.role = worker.role;
    button.disabled = busy || !capabilities?.admin;
    action(button, async () => {
      await api(`/api/admin/agents/${worker.role}/${worker.paused ? 'resume' : 'pause'}`, 'POST');
      notice(`${worker.role} ${worker.paused ? 'resumed' : 'paused'}.`);
    });
    bottom.append(element('span', age === null ? 'NO HEARTBEAT' : `HEARTBEAT ${age}s AGO`), button);
    card.append(top, element('h3', name), element('p', description), bottom);
    $('agents').append(card);
  }
}
async function refresh() {
  if (!token || connecting) return;
  if (refreshPending) return;
  refreshPending = true;
  try {
    const [state, cycles] = await Promise.all([api('/api/swarm'), api('/api/cycles?limit=25')]);
    snapshot = state;
    $('balance').textContent = money(state.availableAtoms);
    $('gross').textContent = money(state.grossTradingPnlAtoms);
    $('reserved').textContent = money(state.reservedAtoms);
    $('asset-label').textContent = `${state.baseAsset} · ${state.mode}`;
    renderAgents(state.workers);
    $('cycles').replaceChildren();
    if (!cycles.length) $('cycles').append(element('p', 'No cycles yet.', 'muted'));
    for (const cycle of cycles) {
      const button = element(
        'button',
        undefined,
        `cycle${selected === cycle.id ? ' selected' : ''}`,
      );
      button.append(element('span', cycle.state), element('small', cycle.id));
      button.addEventListener('click', () => {
        selected = cycle.id;
        costForm.reset();
        economics = null;
        void refresh();
      });
      $('cycles').append(button);
    }
    if (selected) {
      const selectedAtStart = selected;
      const [cycle, costs] = await Promise.all([
        api(`/api/cycles/${selectedAtStart}`),
        api(`/api/cycles/${selectedAtStart}/economics`),
      ]);
      if (selectedAtStart !== selected) return;
      economics = costs;
      $('cycle-state').textContent = cycle.state;
      $('cycle-id').textContent = selected;
      $('cycle-gross').textContent = money(costs.grossTradingPnlAtoms);
      $('cycle-costs').textContent = money(costs.totalCostsIncludingSettlementFeesAtoms);
      $('cycle-net').textContent = money(costs.netAfterApprovedCostsAtoms);
      $('cost-status').textContent =
        costs.status === 'ACCOUNTANT_APPROVED'
          ? `${costs.simulated ? 'SIMULATED · ' : ''}Accountant approved by ${costs.approvedBy}. Net includes the finalization budget; it is not independently verified realized profit.`
          : `Cost basis: ${costs.status.replaceAll('_', ' ').toLowerCase()}. Current share setting: ${costs.requestedShareBps} bps. Missing costs remain unknown.`;
      const receipt = cycle.proofs.find((proof) => proof.kind === 'EXECUTION_RECEIPT');
      $('receipt-status').textContent = receipt
        ? `Receipt: ${receipt.status}. ${receipt.publicDetails.mintedOnChain ? 'Mint recorded on NEAR.' : 'No on-chain mint.'}${receipt.publicDetails.simulatedRightsBps !== undefined ? ` Simulated rights: ${receipt.publicDetails.simulatedRightsBps} bps.` : ''}`
        : 'Receipt has not been issued.';
      if (costs.costs) {
        const approved = {
          ...costs.costs,
          approvedBy: costs.approvedBy,
          valuationMethod: costs.sourceEvidence?.valuationMethod ?? '',
          references: costs.sourceEvidence?.references?.join('\n') ?? '',
        };
        for (const [name, value] of Object.entries(approved))
          costForm.elements.namedItem(name).value = value;
        costForm.elements.namedItem('complete').checked = true;
      }
      $('jobs').replaceChildren();
      for (const job of cycle.jobs) {
        const line = element('div', undefined, 'job');
        line.append(
          element('span', `${job.lane} · attempt ${job.attempts}`),
          element(
            'span',
            job.doneAt
              ? 'DONE'
              : (job.lastError ??
                  (job.leaseUntil
                    ? `LEASE UNTIL ${new Date(job.leaseUntil).toLocaleTimeString()}`
                    : 'QUEUED')),
          ),
        );
        $('jobs').append(line);
      }
    }
    applyAccess();
  } finally {
    refreshPending = false;
  }
}
function scheduleRefresh() {
  if (!refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh().catch((error) => notice(error.message, true));
    }, 500);
}
function eventRow(event) {
  if (seen.has(event.seq)) return;
  seen.add(event.seq);
  cursor = event.seq;
  $('event-cursor').textContent = `CURSOR ${cursor}`;
  const row = element('li');
  const time = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
  const detail =
    event.payload?.action ??
    event.payload?.state ??
    event.payload?.details?.receipt?.simulatedRightsBps;
  row.append(
    element('small', time),
    element(
      'b',
      `${event.topic}${detail !== undefined ? ` · ${detail}` : ''}${event.cycleId ? ` · ${event.cycleId.slice(0, 8)}` : ''}`,
    ),
    element('small', event.mode, 'event-mode'),
  );
  $('events').prepend(row);
  while ($('events').children.length > 80) $('events').lastChild.remove();
  if (seen.size > 500) seen.delete(seen.values().next().value);
  scheduleRefresh();
}
function openSocket() {
  if (!token) return;
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  );
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', token, after: cursor }));
  ws.onmessage = ({ data }) => {
    if (ws !== socket) return;
    const message = JSON.parse(data);
    if (message.type === 'ready') {
      $('connection').textContent = 'EVENT STREAM CONNECTED';
      $('connection').classList.add('live');
    }
    if (message.type === 'event') eventRow(message);
  };
  ws.onclose = ({ code }) => {
    if (ws !== socket || !token) return;
    $('connection').textContent = 'RECONNECTING';
    $('connection').classList.remove('live');
    if (code === 1008) {
      notice('WebSocket authentication failed. Reconnect with a valid token.', true);
      return;
    }
    reconnectTimer = setTimeout(openSocket, 2500);
  };
  ws.onerror = () => {
    $('connection').textContent = 'CONNECTION INTERRUPTED';
  };
}
function disconnect() {
  token = '';
  capabilities = null;
  selected = null;
  economics = null;
  snapshot = null;
  clearTimeout(reconnectTimer);
  clearTimeout(refreshTimer);
  refreshTimer = null;
  const previous = socket;
  socket = null;
  previous?.close();
  $('operations').hidden = true;
  $('disconnect').hidden = true;
  $('connection').textContent = 'DISCONNECTED';
  $('connection').classList.remove('live');
  cursor = '0';
  seen.clear();
  $('events').replaceChildren();
  costForm.reset();
  $('access-token').value = '';
  notice('Disconnected.');
}
// One submit owner keeps credentials out of URLs, persistent storage and rendered text.
$('connect-form').onsubmit = async (event) => {
  event.preventDefault();
  const submitted = $('access-token').value.trim();
  if (!submitted || connecting) return;
  disconnect();
  token = submitted;
  connecting = true;
  try {
    capabilities = await api('/api/capabilities');
    $('operations').hidden = false;
    $('disconnect').hidden = false;
    $('mode').textContent = capabilities.mode;
    $('disclosure').textContent =
      capabilities.mode === 'PAPER'
        ? 'Synthetic funds, prices, inference and settlement. No real trading profit or on-chain NFT is implied.'
        : 'LIVE: real funds and external providers. Costs require evidence; inference attestation does not prove financial reasoning.';
    notice(
      capabilities.admin
        ? 'Administrator connected. Controls affect this treasury.'
        : 'Read access connected. Administrator controls are disabled.',
    );
    connecting = false;
    await refresh();
    openSocket();
  } catch (error) {
    disconnect();
    notice(error.message, true);
  } finally {
    connecting = false;
  }
};
$('disconnect').addEventListener('click', disconnect);
action($('pause-treasury'), async () => {
  await api('/api/admin/pause', 'POST');
  notice('New spending paused. Committed transactions retain their identity and reservations.');
});
action($('resume-treasury'), async () => {
  await api('/api/admin/resume', 'POST');
  notice('New spending resumed.');
});
action($('new-cycle'), async () => {
  const key = `dashboard:${crypto.randomUUID()}`;
  await api('/api/admin/fund', 'POST', { amountAtoms: '20000000', reference: key });
  const cycle = await api(
    '/api/cycles',
    'POST',
    {
      strategy: 'round-trip',
      originChain: 'near:paper',
      destinationChain: 'eip155:31337',
      originAsset: 'USDC',
      intermediateAsset: 'WNEAR',
      amountAtoms: '5000000',
      recipient: 'paper.treasury',
      refundTo: 'paper.treasury',
      slippageBps: 50,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    key,
  );
  selected = cycle.id;
  economics = null;
  costForm.reset();
  notice('PAPER cycle created. Simulated capital is not revenue.');
});
action($('crash-worker'), async () => {
  if (!selected) return;
  await api('/api/admin/demo/crash-worker', 'POST', {
    cycleId: selected,
    role: $('fault-role').value,
  });
  notice(
    'Crash armed for this cycle. Resume the paused agent. The worker will exit after claiming the job; wait for host restart and lease recovery.',
  );
});
action($('cancel-crash'), async () => {
  const result = await api('/api/admin/demo/cancel-crash', 'POST');
  notice(
    result.cancelled
      ? 'Armed crash cancelled.'
      : 'No crash is currently armed. A consumed crash request cannot be cancelled.',
  );
});
$('prefill-paper-costs').addEventListener('click', () => {
  if (
    !economics ||
    capabilities.mode !== 'PAPER' ||
    snapshot.baseAsset !== 'USDC' ||
    snapshot.baseDecimals !== 6
  )
    return;
  const data = {
    computeBaseAtoms: economics.inferenceCostUsdMicros,
    nativeGasBaseAtoms: '0',
    hostingBaseAtoms: '0',
    otherBaseAtoms: '0',
    receiptBudgetBaseAtoms: '1000',
    approvedBy: 'paper-demo-operator',
    valuationMethod:
      'Synthetic PAPER valuation. Native/NEAR gas and hosting are simulated as zero; receipt gas is a synthetic budget. Not actual business expenses.',
    references:
      'paper:synthetic-inference\npaper:zero-native-and-near-gas\npaper:zero-hosting\npaper:receipt-gas-budget',
  };
  for (const [name, value] of Object.entries(data)) costForm.elements.namedItem(name).value = value;
  costForm.elements.namedItem('complete').checked = false;
  notice(
    'Synthetic costs filled. Review the disclosure and check the acknowledgement before approval.',
  );
});
costForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !economics || !selected) return;
  const fields = new FormData(costForm);
  busy = true;
  applyAccess();
  try {
    const values = Object.fromEntries(
      [
        'computeBaseAtoms',
        'nativeGasBaseAtoms',
        'hostingBaseAtoms',
        'otherBaseAtoms',
        'receiptBudgetBaseAtoms',
        'approvedBy',
      ].map((key) => [key, fields.get(key)]),
    );
    if (!fields.get('complete'))
      throw new Error('Confirm that gas and hosting costs are included.');
    await api(`/api/admin/cycles/${selected}/cost-basis`, 'POST', {
      ...values,
      settlementDigest: economics.settlementDigest,
      inferenceCostUsdMicros: economics.inferenceCostUsdMicros,
      sourceEvidence: {
        nativeFeeEvidenceDigest: economics.nativeFeeEvidenceDigest,
        valuationMethod: fields.get('valuationMethod'),
        references: String(fields.get('references'))
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        includesNearGasAndHosting: true,
      },
    });
    notice(
      'Cost basis approved and bound to this settlement. The worker can now evaluate the receipt rights.',
    );
    await refresh();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    applyAccess();
  }
});
setInterval(() => {
  if (token && !connecting)
    void refresh().catch(() => {
      notice(
        'Service temporarily unavailable. Waiting for restart; stored events and jobs remain in PostgreSQL.',
        true,
      );
    });
}, 5000);
