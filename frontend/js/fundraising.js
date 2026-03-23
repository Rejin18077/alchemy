// ─── Fundraising Controls ───────────────────────────────────────

function formatUsd(value) {
  const number = Number(value || 0);
  return `$${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

async function refreshFundingStatus() {
  const res = await fetch(`${API_BASE}/api/fundraising/status`);
  const payload = await res.json();
  state.fundingStatus = payload.config || null;
  state.campaigns = payload.campaigns || [];
  renderFundingStatus();
  renderCampaignList();
  syncCampaignSelector();
}

function renderFundingStatus() {
  const el = document.getElementById('fundraising-meta');
  if (!el) return;
  const cfg = state.fundingStatus;
  if (!cfg) {
    el.innerHTML = 'Funding rails unavailable.';
    return;
  }
  el.innerHTML = `
    <div><strong>Treasury:</strong> ${escapeHtml(cfg.treasury_account_id || 'not-configured')}</div>
    <div><strong>Asset:</strong> ${escapeHtml(cfg.accepted_asset || 'HBAR')}</div>
    <div><strong>Campaigns:</strong> ${escapeHtml(String(cfg.campaign_count || 0))}</div>
    <div><strong>Investors:</strong> ${escapeHtml(String(cfg.investor_count || 0))}</div>
  `;
}

function renderCampaignList() {
  const el = document.getElementById('campaign-list');
  if (!el) return;
  if (!state.campaigns.length) {
    el.innerHTML = '<div class="empty-state">No funding campaigns yet. Run the pipeline to create one.</div>';
    return;
  }
  el.innerHTML = state.campaigns.map((campaign) => `
    <div class="campaign-card" data-campaign-id="${escapeHtml(campaign.id)}">
      <div><strong>${escapeHtml(campaign.title || campaign.id)}</strong></div>
      <div>Status: ${escapeHtml(campaign.status || 'OPEN')}</div>
      <div>Goal: ${escapeHtml(formatUsd(campaign.goalUsd))}</div>
      <div>Raised: ${escapeHtml(formatUsd(campaign.raisedUsd))}</div>
      <div>Treasury: ${escapeHtml(campaign.treasuryAccountId || 'not-configured')}</div>
    </div>
  `).join('');
}

function getSelectedCampaignId() {
  const select = document.getElementById('campaign-id');
  return select?.value?.trim() || state.campaigns[0]?.id || '';
}

function syncCampaignSelector() {
  const select = document.getElementById('campaign-id');
  if (!select) return;
  const current = select.value;
  select.innerHTML = state.campaigns.map((campaign) =>
    `<option value="${escapeHtml(campaign.id)}">${escapeHtml(campaign.title || campaign.id)}</option>`
  ).join('');

  if (state.campaigns.some((campaign) => campaign.id === current)) select.value = current;
}

async function createCampaignFromFundraising() {
  if (!state.results.fundraising) {
    addStatusMessage('Run the fundraising agent first to create a campaign.', 'error');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/fundraising/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experimentId: state.experimentId,
        hypothesis: state.hypothesis?.hypotheses?.[0] || state.hypothesis,
        fundingResult: state.results.fundraising
      })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Campaign creation failed');
    await refreshFundingStatus();
    addStatusMessage(`Funding campaign ${payload.campaign?.id} created.`, 'success');
  } catch (err) {
    addStatusMessage(`Campaign creation failed: ${err.message}`, 'error');
  }
}

async function saveInvestorProfile() {
  const accountId = document.getElementById('investor-account')?.value?.trim();
  if (!accountId) { addStatusMessage('Hedera account ID is required.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/api/fundraising/investors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        displayName: document.getElementById('investor-name')?.value?.trim(),
        alias: document.getElementById('investor-alias')?.value?.trim(),
        riskAppetite: document.getElementById('investor-risk')?.value || 'balanced',
        walletProvider: document.getElementById('wallet-provider')?.value?.trim()
      })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Save failed');
    state.investorProfile = payload.investor;
    addStatusMessage(`Investor profile saved.`, 'success');
  } catch (err) {
    addStatusMessage(`Investor profile failed: ${err.message}`, 'error');
  }
}

async function findFundingMatches() {
  const accountId = document.getElementById('investor-account')?.value?.trim();
  if (!accountId) { addStatusMessage('Investor Hedera account ID is required.', 'error'); return; }
  try {
    const res = await fetch(`${API_BASE}/api/fundraising/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        displayName: document.getElementById('investor-name')?.value?.trim(),
        alias: document.getElementById('investor-alias')?.value?.trim(),
        riskAppetite: document.getElementById('investor-risk')?.value || 'balanced',
        walletProvider: document.getElementById('wallet-provider')?.value?.trim()
      })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Matching failed');
    state.matchResults = payload.matches || [];
    const matchBox = document.getElementById('match-results');
    if (matchBox) {
      matchBox.innerHTML = state.matchResults.length
        ? state.matchResults.slice(0, 5).map(m => `<div>${escapeHtml(m.campaign.title)} - score ${escapeHtml(String(m.score))}</div>`).join('')
        : 'No matches yet.';
    }
    addStatusMessage('Marketplace matches refreshed.', 'success');
  } catch (err) {
    addStatusMessage(`Matching failed: ${err.message}`, 'error');
  }
}

async function createContributionIntent() {
  const campaignId = getSelectedCampaignId();
  const cId = document.getElementById('investor-account')?.value?.trim();
  const amountUsd = document.getElementById('contribution-usd')?.value?.trim();
  if (!campaignId || !cId || !amountUsd) { addStatusMessage('Campaign, account, and amount are required.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/api/fundraising/contribution-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId, contributorAccountId: cId, amountUsd,
        displayName: document.getElementById('investor-name')?.value?.trim(),
        riskAppetite: document.getElementById('investor-risk')?.value || 'balanced',
        walletProvider: document.getElementById('wallet-provider')?.value?.trim(),
        alias: document.getElementById('investor-alias')?.value?.trim()
      })
    });
    const p = await res.json();
    if (!res.ok) throw new Error(p.error || 'Intent failed');
    state.lastContributionIntent = p.intent;
    const meta = document.getElementById('contribution-meta');
    if (meta) {
      meta.innerHTML = `<div><strong>Memo:</strong> ${escapeHtml(p.intent.paymentMemo)}</div>
        <div><strong>Treasury:</strong> ${escapeHtml(p.intent.treasuryAccountId || 'none')}</div>
        <div><strong>Amount:</strong> ${escapeHtml(String(p.intent.amountHbar))} HBAR</div>
        <div>${escapeHtml(p.intent.instructions)}</div>`;
    }
    addStatusMessage('Contribution intent generated.', 'success');
  } catch (err) {
    addStatusMessage(`Intent failed: ${err.message}`, 'error');
  }
}

async function recordContribution() {
  const campaignId = getSelectedCampaignId();
  const cid = document.getElementById('investor-account')?.value?.trim();
  const amountUsd = document.getElementById('contribution-usd')?.value?.trim();
  const txid = document.getElementById('contribution-txid')?.value?.trim();
  if (!campaignId || !cid || !amountUsd) { addStatusMessage('Campaign, account, and amount are required.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/api/fundraising/contributions/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contributorAccountId: cid, amountUsd, transactionId: txid, verifyOnMirrorNode: Boolean(txid) })
    });
    const p = await res.json();
    if (!res.ok) throw new Error(p.error || 'Record failed');
    await refreshFundingStatus();
    addStatusMessage(`Contribution recorded for ${p.contribution.contributorAccountId}.`, 'success');
  } catch (err) {
    addStatusMessage(`Record failed: ${err.message}`, 'error');
  }
}
