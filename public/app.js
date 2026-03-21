// ALCHEMY Protocol — Main Application Logic

const API_BASE = window.location.origin;

// State
const state = {
  running: false,
  currentAgent: null,
  results: {},
  hcsMessages: [],
  holRegistry: {},
  experimentId: null,
  hypothesis: null,
  chatHistory: [],
  agentCard: null,
  campaigns: [],
  fundingStatus: null,
  investorProfile: null,
  matchResults: [],
  lastContributionIntent: null,
  laborStatus: null,
  laborMarketplaces: []
};

// ─── API Helpers ───────────────────────────────────────────────

async function callAgent(agentKey, userMessage, maxTokens = 4096, extra = {}) {
  const agent = AGENTS[agentKey];
  const response = await fetch(`${API_BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentKey,
      systemPrompt: agent.systemPrompt,
      userMessage,
      maxTokens,
      ...extra
    })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function logToHCS(entry) {
  await fetch(`${API_BASE}/api/hcs/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  });
  await refreshHCSLog();
}

async function updateHOL(data) {
  await fetch(`${API_BASE}/api/hol/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  await refreshHOLRegistry();
}

async function refreshHCSLog() {
  const res = await fetch(`${API_BASE}/api/hcs/log`);
  state.hcsMessages = await res.json();
  renderHCSLog();
}

async function refreshHOLRegistry() {
  const res = await fetch(`${API_BASE}/api/hol/registry`);
  state.holRegistry = await res.json();
  renderHOLRegistry();
}

async function refreshAgentCard() {
  const res = await fetch(`${API_BASE}/api/agent/card`);
  state.agentCard = await res.json();
  renderAgentCard();
}

async function refreshChatHistory() {
  const res = await fetch(`${API_BASE}/api/chat/history`);
  state.chatHistory = await res.json();
  renderChatHistory();
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

async function refreshLaborStatus() {
  const res = await fetch(`${API_BASE}/api/labor/status`);
  const payload = await res.json();
  state.laborStatus = payload.config || null;
  state.laborMarketplaces = payload.marketplaces || [];
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function trustLevelFromScore(score) {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  return 'LOW';
}

function assessTopicQuality(topic) {
  const text = String(topic || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const charCount = text.length;
  let score = 0.2;
  const issues = [];

  if (charCount < 5 || tokens.length < 2) {
    issues.push('too_short');
    score -= 0.15;
  }
  if (/^[a-z]$/i.test(text) || /^[a-z]{1,2}$/i.test(text)) {
    issues.push('single_token');
    score -= 0.2;
  }
  if (tokens.length >= 4) {
    score += 0.2;
  }
  if (charCount >= 20) {
    score += 0.2;
  }
  if (/\b(effect|impact|improve|relationship|benchmark|dataset|model|method|using|versus|on)\b/i.test(text)) {
    score += 0.15;
  } else {
    issues.push('low_specificity');
  }
  if (/[0-9]/.test(text)) {
    score += 0.05;
  }

  return {
    score: clamp(score),
    issues,
    usable: clamp(score) >= 0.45
  };
}

function getRetrievalPenalty(result) {
  const retrieval = result?.retrieval || null;
  if (!retrieval) return 0.1;
  if (retrieval.degraded || retrieval.warning) return 0.25;
  if ((retrieval.totalFetched || 0) === 0) return 0.2;
  return 0;
}

function computeStageReputation(topic, stage, result, context = {}) {
  const topicQuality = assessTopicQuality(topic);
  const retrievalPenalty = getRetrievalPenalty(result);
  let score = 0.25 + (topicQuality.score * 0.35) - retrievalPenalty;

  if (stage === 'hypothesis') {
    const gaps = result?.parsed?.gaps?.length || 0;
    const hypotheses = result?.parsed?.hypotheses?.length || 0;
    score += Math.min(0.2, (gaps * 0.04) + (hypotheses * 0.04));
    if (!topicQuality.usable) score = Math.min(score, 0.38);
  }

  if (stage === 'peerReview') {
    const decision = result?.parsed?.final_decision;
    const confidence = String(result?.parsed?.confidence || '').toLowerCase();
    if (decision === 'ACCEPT') score += 0.18;
    if (decision === 'REVISE') score += 0.04;
    if (decision === 'REJECT') score -= 0.18;
    if (confidence === 'high') score += 0.08;
    if (confidence === 'low') score -= 0.08;
    if (!topicQuality.usable) score = Math.min(score, 0.45);
  }

  if (stage === 'fundraising') {
    const decision = result?.parsed?.final_decision;
    if (decision === 'APPROVED_FOR_EXECUTION') score += 0.12;
    if (decision === 'WAITING_FOR_MORE_FUNDS') score += 0.02;
    if (decision === 'REJECTED') score -= 0.14;
    if (!topicQuality.usable) score = Math.min(score, 0.42);
  }

  if (stage === 'labor') {
    const tasks = result?.parsed?.tasks?.length || 0;
    score += Math.min(0.12, tasks * 0.02);
    if (!topicQuality.usable) score = Math.min(score, 0.5);
  }

  if (stage === 'results') {
    const finalStatus = result?.parsed?.final_status;
    if (finalStatus === 'SUCCESS') score += 0.18;
    if (finalStatus === 'PARTIAL_SUCCESS') score += 0.08;
    if (finalStatus === 'FAILURE') score -= 0.12;
    if (!topicQuality.usable) score = Math.min(score, 0.6);
  }

  if (stage === 'replication') {
    const trustLevel = result?.parsed?.trust?.level;
    const trustConfidence = Number(result?.parsed?.trust?.confidence || 0);
    if (trustLevel === 'HIGH') score += 0.22;
    if (trustLevel === 'MEDIUM') score += 0.1;
    if (trustLevel === 'LOW') score -= 0.16;
    score += Math.min(0.08, trustConfidence * 0.08);
    if (!topicQuality.usable) score = Math.min(score, 0.55);
  }

  if (context.peerReviewDecision === 'REJECT') {
    score = Math.min(score, 0.35);
  }

  score = clamp(score);
  return {
    reputation_score: Number(score.toFixed(2)),
    trust_level: trustLevelFromScore(score),
    topic_quality: topicQuality
  };
}

// ─── UI Helpers ───────────────────────────────────────────────

function setAgentStatus(agentKey, status) {
  // status: idle | running | done | error
  const card = document.getElementById(`card-${agentKey}`);
  if (!card) return;
  card.dataset.status = status;
  const indicator = card.querySelector('.agent-indicator');
  if (indicator) {
    indicator.className = `agent-indicator ${status}`;
  }
}

function updateAgentOutput(agentKey, data, error = null) {
  const outputEl = document.getElementById(`output-${agentKey}`);
  if (!outputEl) return;

  if (error) {
    outputEl.innerHTML = `<div class="error-msg">❌ ${error}</div>`;
    return;
  }

  let content = data?.parsed || (typeof data?.raw === 'string' ? tryParseJSON(data.raw) : data);
  if (content && typeof content === 'object' && !Array.isArray(content) && (data?.retrieval || data?.provider)) {
    content = {
      _runtime: {
        provider: data.provider || 'unknown',
        model: data.model || 'unknown',
        fallbackReason: data.fallbackReason || null
      },
      _retrieval: data.retrieval ? {
        provider: data.retrieval.provider,
        embeddingModel: data.retrieval.embeddingModel,
        totalFetched: data.retrieval.totalFetched,
        papers: data.retrieval.papers?.map(p => ({
          title: p.title,
          year: p.year,
          venue: p.venue,
          relevanceScore: p.relevanceScore,
          citationCount: p.citationCount,
          url: p.url
        }))
      } : null,
      ...content
    };
  }
  outputEl.innerHTML = renderJSONOutput(content);
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return str;
  }
}

function renderJSONOutput(obj) {
  if (typeof obj === 'string') return `<div class="raw-text">${escapeHtml(obj)}</div>`;
  return `<pre class="json-output">${syntaxHighlight(JSON.stringify(obj, null, 2))}</pre>`;
}

function syntaxHighlight(json) {
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      cls = /:$/.test(match) ? 'json-key' : 'json-string';
    } else if (/true|false/.test(match)) {
      cls = 'json-bool';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${escapeHtml(match)}</span>`;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function addStatusMessage(msg, type = 'info') {
  const log = document.getElementById('status-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString();
  const icons = { info: '◆', success: '✓', error: '✗', hcs: '⬡', warn: '⚠' };
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-icon">${icons[type] || '◆'}</span><span class="log-msg">${msg}</span>`;
  log.insertBefore(entry, log.firstChild);
  if (log.children.length > 50) log.removeChild(log.lastChild);
}

function renderHCSLog() {
  const el = document.getElementById('hcs-messages');
  if (!el) return;
  if (state.hcsMessages.length === 0) {
    el.innerHTML = '<div class="empty-state">No messages yet. Run an experiment to see HCS-10 messages flow.</div>';
    return;
  }
  el.innerHTML = state.hcsMessages.slice(0, 20).map(m => `
    <div class="hcs-message">
      <div class="hcs-msg-header">
        <span class="hcs-agent-badge" style="color:${getAgentColor(m.agent_type)}">${m.agent_type || 'SYSTEM'}</span>
        <span class="hcs-action">${m.action_type || m.event || 'MESSAGE'}</span>
        <span class="hcs-time">${formatTime(m.timestamp)}</span>
      </div>
      <div class="hcs-msg-id">ID: ${(m.id || m.message_id || '').substring(0, 24)}...</div>
      ${m.experiment_id ? `<div class="hcs-exp-id">EXP: ${m.experiment_id}</div>` : ''}
    </div>
  `).join('');
}

function renderHOLRegistry() {
  const el = document.getElementById('hol-agents');
  if (!el) return;
  const agents = Object.values(state.holRegistry);
  if (agents.length === 0) {
    el.innerHTML = '<div class="empty-state">No agents registered yet.</div>';
    return;
  }
  el.innerHTML = agents.map(a => {
    const score = parseFloat(a.reputation_score) || 0;
    const pct = Math.round(score * 100);
    const color = a.trust_level === 'HIGH' ? '#22c55e' : a.trust_level === 'MEDIUM' ? '#f59e0b' : '#ef4444';
    return `
      <div class="hol-agent">
        <div class="hol-agent-header">
          <span class="hol-agent-id">${a.agent_id}</span>
          <span class="hol-trust" style="color:${color}">${a.trust_level || 'UNKNOWN'}</span>
        </div>
        <div class="hol-rep-bar">
          <div class="hol-rep-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="hol-rep-score">${pct}% reputation</div>
        <div class="hol-contributions">${(a.contributions || []).length} contributions</div>
      </div>
    `;
  }).join('');
}

function renderAgentCard() {
  const el = document.getElementById('agent-card-meta');
  if (!el) return;
  if (!state.agentCard) {
    el.innerHTML = 'Agent card unavailable.';
    return;
  }

  const reg = state.agentCard.registration || {};
  const hcs10 = state.agentCard.reachability?.hcs10 || {};
  el.innerHTML = `
    <div><strong>${escapeHtml(state.agentCard.name || 'ALCHEMY')}</strong></div>
    <div>Status: ${escapeHtml(reg.status || 'unregistered')}</div>
    <div>Chat: ${escapeHtml(state.agentCard.reachability?.naturalLanguageChat || 'n/a')}</div>
    <div>Inbound Topic: ${escapeHtml(hcs10.inboundTopicId || 'not-created')}</div>
    <div>UAID: ${escapeHtml(reg.uaid || 'not-assigned')}</div>
  `;
}

function renderChatHistory() {
  const el = document.getElementById('chat-log');
  if (!el) return;
  if (!state.chatHistory.length) {
    el.innerHTML = '<div class="empty-state">Start a conversation with the agent.</div>';
    return;
  }

  el.innerHTML = state.chatHistory.slice(-10).map(entry => `
    <div class="chat-msg">
      <div class="chat-role">${escapeHtml(entry.role || 'assistant')}</div>
      <div class="chat-content">${escapeHtml(entry.content || '')}</div>
    </div>
  `).join('');
  el.scrollTop = el.scrollHeight;
}

function formatUsd(value) {
  const number = Number(value || 0);
  return `$${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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
    el.innerHTML = '<div class="empty-state">No funding campaigns yet. Run the pipeline to create one from the fundraising agent.</div>';
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

  if (state.campaigns.some((campaign) => campaign.id === current)) {
    select.value = current;
  }
}

async function registerHolAgent() {
  const btn = document.getElementById('register-agent-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Registering...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/hol/register`, { method: 'POST' });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || 'Registration failed');
    }
    state.agentCard = payload.card || state.agentCard;
    renderAgentCard();
    await refreshHOLRegistry();
    addStatusMessage('HOL agent registration completed.', 'success');
  } catch (err) {
    addStatusMessage(`HOL registration failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Register Agent via HOL';
    }
  }
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
    if (!res.ok) {
      throw new Error(payload.error || 'Campaign creation failed');
    }
    await refreshFundingStatus();
    addStatusMessage(`Funding campaign ${payload.campaign?.id} created.`, 'success');
  } catch (err) {
    addStatusMessage(`Campaign creation failed: ${err.message}`, 'error');
  }
}

async function saveInvestorProfile() {
  const accountId = document.getElementById('investor-account')?.value?.trim();
  if (!accountId) {
    addStatusMessage('Investor Hedera account ID is required.', 'error');
    return;
  }

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
    if (!res.ok) {
      throw new Error(payload.error || 'Investor save failed');
    }
    state.investorProfile = payload.investor;
    addStatusMessage(`Investor profile saved for ${payload.investor.accountId}.`, 'success');
  } catch (err) {
    addStatusMessage(`Investor profile failed: ${err.message}`, 'error');
  }
}

async function findFundingMatches() {
  const accountId = document.getElementById('investor-account')?.value?.trim();
  if (!accountId) {
    addStatusMessage('Investor Hedera account ID is required.', 'error');
    return;
  }

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
    if (!res.ok) {
      throw new Error(payload.error || 'Matching failed');
    }
    state.matchResults = payload.matches || [];
    const matchBox = document.getElementById('match-results');
    if (matchBox) {
      matchBox.innerHTML = state.matchResults.length
        ? state.matchResults.slice(0, 5).map((match) => `<div>${escapeHtml(match.campaign.title)} - score ${escapeHtml(String(match.score))}</div>`).join('')
        : 'No matches yet.';
    }
    addStatusMessage('Marketplace matches refreshed.', 'success');
  } catch (err) {
    addStatusMessage(`Matching failed: ${err.message}`, 'error');
  }
}

async function createContributionIntent() {
  const campaignId = getSelectedCampaignId();
  const contributorAccountId = document.getElementById('investor-account')?.value?.trim();
  const amountUsd = document.getElementById('contribution-usd')?.value?.trim();
  if (!campaignId || !contributorAccountId || !amountUsd) {
    addStatusMessage('Campaign, investor account, and contribution amount are required.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fundraising/contribution-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId,
        contributorAccountId,
        amountUsd,
        displayName: document.getElementById('investor-name')?.value?.trim(),
        riskAppetite: document.getElementById('investor-risk')?.value || 'balanced',
        walletProvider: document.getElementById('wallet-provider')?.value?.trim(),
        alias: document.getElementById('investor-alias')?.value?.trim()
      })
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || 'Contribution intent failed');
    }
    state.lastContributionIntent = payload.intent;
    const meta = document.getElementById('contribution-meta');
    if (meta) {
      meta.innerHTML = `
        <div><strong>Memo:</strong> ${escapeHtml(payload.intent.paymentMemo)}</div>
        <div><strong>Treasury:</strong> ${escapeHtml(payload.intent.treasuryAccountId || 'not-configured')}</div>
        <div><strong>Amount:</strong> ${escapeHtml(String(payload.intent.amountHbar))} HBAR</div>
        <div>${escapeHtml(payload.intent.instructions)}</div>
      `;
    }
    addStatusMessage('Contribution intent generated.', 'success');
  } catch (err) {
    addStatusMessage(`Contribution intent failed: ${err.message}`, 'error');
  }
}

async function recordContribution() {
  const campaignId = getSelectedCampaignId();
  const contributorAccountId = document.getElementById('investor-account')?.value?.trim();
  const amountUsd = document.getElementById('contribution-usd')?.value?.trim();
  const transactionId = document.getElementById('contribution-txid')?.value?.trim();
  if (!campaignId || !contributorAccountId || !amountUsd) {
    addStatusMessage('Campaign, investor account, and contribution amount are required.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fundraising/contributions/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId,
        contributorAccountId,
        amountUsd,
        transactionId,
        verifyOnMirrorNode: Boolean(transactionId)
      })
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || 'Contribution recording failed');
    }
    await refreshFundingStatus();
    addStatusMessage(`Contribution recorded for ${payload.contribution.contributorAccountId}.`, 'success');
  } catch (err) {
    addStatusMessage(`Contribution record failed: ${err.message}`, 'error');
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  const message = input?.value?.trim();
  if (!message) return;
  const historyBeforeSend = state.chatHistory.slice(-8);

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending...';
  }

  const pendingHistory = [...state.chatHistory, { role: 'user', content: message }];
  state.chatHistory = pendingHistory;
  renderChatHistory();
  input.value = '';

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: historyBeforeSend })
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || 'Chat failed');
    }
    state.chatHistory = payload.history || [...pendingHistory, { role: 'assistant', content: payload.reply }];
    renderChatHistory();
  } catch (err) {
    state.chatHistory = [...pendingHistory, { role: 'assistant', content: `Error: ${err.message}` }];
    renderChatHistory();
    addStatusMessage(`Chat failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send Chat Message';
    }
  }
}

function getAgentColor(type) {
  const colors = {
    'HYPOTHESIS': '#7c3aed', 'PEER_REVIEW': '#c2410c', 'FUNDRAISING': '#b45309',
    'LABOR': '#0f766e', 'RESULTS': '#0369a1', 'REPLICATION': '#15803d',
    'HCS_REGISTRY': '#475569', 'SYSTEM': '#64748b'
  };
  return colors[type] || '#94a3b8';
}

function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
}

function generateExperimentId() {
  return `EXP-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

// ─── Pipeline ───────────────────────────────────────────────

async function runPipeline() {
  if (state.running) return;

  const topic = document.getElementById('research-topic')?.value?.trim();
  if (!topic) {
    alert('Please enter a research topic first.');
    return;
  }

  state.running = true;
  state.results = {};
  state.experimentId = generateExperimentId();

  document.getElementById('run-btn').disabled = true;
  document.getElementById('run-btn').textContent = '⚡ Running Pipeline...';

  // Reset all cards
  Object.keys(AGENTS).forEach(k => {
    setAgentStatus(k, 'idle');
    const out = document.getElementById(`output-${k}`);
    if (out) out.innerHTML = '<div class="waiting">Waiting...</div>';
  });

  // Clear logs
  await fetch(`${API_BASE}/api/hcs/log`, { method: 'DELETE' });
  await fetch(`${API_BASE}/api/hol/registry`, { method: 'DELETE' });

  addStatusMessage(`🧪 Starting experiment ${state.experimentId} on: "${topic}"`, 'info');

  try {
    // ── STEP 1: Hypothesis Agent ──────────────────────────────
    await runAgentStep('hypothesis', 'Hypothesis Agent', async () => {
      const prompt = AGENTS.hypothesis.buildPrompt(topic);
      const result = await callAgent('hypothesis', prompt, 4096, { topic });
      state.results.hypothesis = result.parsed || result;
      state.hypothesis = result.parsed || {};
      updateAgentOutput('hypothesis', result);

      await logToHCS({
        message_id: `msg-hyp-${Date.now()}`,
        agent_id: AGENTS.hypothesis.id,
        agent_type: 'HYPOTHESIS',
        action_type: 'HYPOTHESIS_GENERATED',
        experiment_id: state.experimentId,
        payload: { gaps_count: (result.parsed?.gaps || []).length, hypotheses_count: (result.parsed?.hypotheses || []).length }
      });

      const reputation = computeStageReputation(topic, 'hypothesis', result);
      await updateHOL({
        agent_id: AGENTS.hypothesis.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: [state.experimentId]
      });
    });

    // ── STEP 2: Peer Review Agent ──────────────────────────────
    const firstHypothesis = state.hypothesis?.hypotheses?.[0] || { statement: topic };
    await runAgentStep('peerReview', 'Peer Review Agent', async () => {
      const prompt = AGENTS.peerReview.buildPrompt(firstHypothesis);
      const result = await callAgent('peerReview', prompt, 4096, {
        hypothesis: firstHypothesis,
        experimentId: state.experimentId
      });
      state.results.peerReview = result.parsed || result;
      updateAgentOutput('peerReview', result);

      await logToHCS({
        message_id: `msg-pr-${Date.now()}`,
        agent_id: AGENTS.peerReview.id,
        agent_type: 'PEER_REVIEW',
        action_type: 'REVIEW_COMPLETED',
        experiment_id: state.experimentId,
        payload: { decision: result.parsed?.final_decision, confidence: result.parsed?.confidence }
      });

      const reputation = computeStageReputation(topic, 'peerReview', result);
      await updateHOL({
        agent_id: AGENTS.peerReview.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: []
      });
    });

    // ── STEP 3: Fundraising Agent ──────────────────────────────
    await runAgentStep('fundraising', 'Fundraising Agent', async () => {
      const prompt = AGENTS.fundraising.buildPrompt(firstHypothesis, state.results.peerReview);
      const result = await callAgent('fundraising', prompt, 4096);
      state.results.fundraising = result.parsed || result;
      updateAgentOutput('fundraising', result);

      const campaignRes = await fetch(`${API_BASE}/api/fundraising/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experimentId: state.experimentId,
          hypothesis: firstHypothesis,
          fundingResult: state.results.fundraising
        })
      });
      if (campaignRes.ok) {
        await refreshFundingStatus();
      }

      await logToHCS({
        message_id: `msg-fund-${Date.now()}`,
        agent_id: AGENTS.fundraising.id,
        agent_type: 'FUNDRAISING',
        action_type: 'FUNDING_DECISION',
        experiment_id: state.experimentId,
        payload: { decision: result.parsed?.final_decision, total_raised: result.parsed?.funding_status?.total_raised }
      });

      const reputation = computeStageReputation(topic, 'fundraising', result, {
        peerReviewDecision: state.results.peerReview?.final_decision
      });
      await updateHOL({
        agent_id: AGENTS.fundraising.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: []
      });
    });

    // Check if funded
    const fundingDecision = state.results.fundraising?.final_decision;
    if (fundingDecision === 'REJECTED') {
      addStatusMessage('💀 Experiment rejected by investors. Pipeline halted.', 'error');
      ['labor', 'results', 'replication'].forEach(k => setAgentStatus(k, 'error'));
      return;
    }

    // ── STEP 4: Labor Market Agent ──────────────────────────────
    await runAgentStep('labor', 'Labor Market Agent', async () => {
      const prompt = AGENTS.labor.buildPrompt(firstHypothesis, state.results.fundraising);
      const result = await callAgent('labor', prompt, 4096);
      state.results.labor = result.parsed || result;
      updateAgentOutput('labor', result);

      const marketplaceRes = await fetch(`${API_BASE}/api/labor/marketplaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experimentId: state.experimentId,
          hypothesis: firstHypothesis,
          laborResult: state.results.labor
        })
      });
      if (marketplaceRes.ok) {
        const payload = await marketplaceRes.json();
        await refreshLaborStatus();
        addStatusMessage(`Labor marketplace ${payload.marketplace?.id} opened with ${payload.marketplace?.tasks?.length || 0} tasks.`, 'success');
      }

      const tasksCount = result.parsed?.tasks?.length || 0;
      await logToHCS({
        message_id: `msg-lab-${Date.now()}`,
        agent_id: AGENTS.labor.id,
        agent_type: 'LABOR',
        action_type: 'TASKS_PUBLISHED',
        experiment_id: state.experimentId,
        payload: { tasks_count: tasksCount, token: 'EXP_TOKEN', total_allocated: result.parsed?.hedera?.token_service?.total_allocated }
      });

      const reputation = computeStageReputation(topic, 'labor', result, {
        peerReviewDecision: state.results.peerReview?.final_decision
      });
      await updateHOL({
        agent_id: AGENTS.labor.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: []
      });
    });

    // ── STEP 5: Results Agent ──────────────────────────────────
    await runAgentStep('results', 'Results Agent', async () => {
      const prompt = AGENTS.results.buildPrompt(firstHypothesis, state.results.labor);
      const result = await callAgent('results', prompt, 4096, {
        hypothesis: firstHypothesis,
        experimentId: state.experimentId,
        laborResult: state.results.labor
      });
      state.results.results = result.parsed || result;
      updateAgentOutput('results', result);

      await logToHCS({
        message_id: `msg-res-${Date.now()}`,
        agent_id: AGENTS.results.id,
        agent_type: 'RESULTS',
        action_type: 'RESULT_PUBLISHED',
        experiment_id: state.experimentId,
        payload: {
          status: result.parsed?.final_status,
          metrics: result.parsed?.metrics,
          nft_token_id: result.parsed?.hedera_record?.nft_token_id
        }
      });

      const reputation = computeStageReputation(topic, 'results', result, {
        peerReviewDecision: state.results.peerReview?.final_decision
      });
      await updateHOL({
        agent_id: AGENTS.results.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: [state.experimentId]
      });
    });

    // ── STEP 6: Replication Agent ──────────────────────────────
    await runAgentStep('replication', 'Replication Agent', async () => {
      const prompt = AGENTS.replication.buildPrompt(firstHypothesis, state.results.results);
      const result = await callAgent('replication', prompt, 4096, {
        hypothesis: firstHypothesis,
        experimentId: state.experimentId,
        resultsData: state.results.results
      });
      state.results.replication = result.parsed || result;
      updateAgentOutput('replication', result);

      await logToHCS({
        message_id: `msg-rep-${Date.now()}`,
        agent_id: AGENTS.replication.id,
        agent_type: 'REPLICATION',
        action_type: 'REPLICATION_DONE',
        experiment_id: state.experimentId,
        payload: {
          verdict: result.parsed?.final_verdict,
          trust_level: result.parsed?.trust?.level,
          deviation: result.parsed?.comparison?.deviation
        }
      });

      const reputation = computeStageReputation(topic, 'replication', result, {
        peerReviewDecision: state.results.peerReview?.final_decision
      });
      await updateHOL({
        agent_id: AGENTS.replication.id,
        reputation_score: reputation.reputation_score,
        trust_level: reputation.trust_level,
        contributions: [state.experimentId],
        owned_experiments: []
      });
    });

    addStatusMessage(`✅ Experiment ${state.experimentId} completed successfully!`, 'success');
    showSuccessModal();

  } catch (err) {
    addStatusMessage(`❌ Pipeline error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    state.running = false;
    document.getElementById('run-btn').disabled = false;
    document.getElementById('run-btn').textContent = '⚡ Run Experiment';
  }
}

async function runAgentStep(agentKey, agentName, fn) {
  setAgentStatus(agentKey, 'running');
  addStatusMessage(`▶ Running ${agentName}...`, 'info');

  // Scroll to agent card
  const card = document.getElementById(`card-${agentKey}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    await fn();
    setAgentStatus(agentKey, 'done');
    addStatusMessage(`✓ ${agentName} completed`, 'success');
  } catch (err) {
    setAgentStatus(agentKey, 'error');
    updateAgentOutput(agentKey, null, err.message);
    addStatusMessage(`✗ ${agentName} failed: ${err.message}`, 'error');
    throw err;
  }
}

function showSuccessModal() {
  const modal = document.getElementById('success-modal');
  if (modal) {
    modal.classList.add('visible');
    setTimeout(() => modal.classList.remove('visible'), 4000);
  }
}

// ─── Tab Management ────────────────────────────────────────────

function switchTab(agentKey) {
  document.querySelectorAll('.agent-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.agent === agentKey);
  });
  document.querySelectorAll('.agent-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.agent === agentKey);
  });
}

// ─── Init ─────────────────────────────────────────────────────

async function init() {
  // Check server health
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const health = await res.json();
    const apiStatus = document.getElementById('api-status');
    if (apiStatus) {
      if (health.mistral === 'configured' || health.inference?.ollama === 'reachable') {
        const provider = health.mistral === 'configured' ? 'Mistral' : 'Ollama fallback';
        apiStatus.innerHTML = `<span class="status-dot green"></span> ${provider} ready`;
        apiStatus.className = 'api-status connected';
      } else {
        apiStatus.innerHTML = `<span class="status-dot red"></span> Missing Mistral and Ollama fallback`;
        apiStatus.className = 'api-status error';
      }
    }
  } catch (e) {
    console.error('Server not reachable:', e);
  }

  // Load initial state
  await refreshHCSLog();
  await refreshHOLRegistry();
  await refreshAgentCard();
  await refreshChatHistory();
  await refreshFundingStatus();
  await refreshLaborStatus();

  addStatusMessage('ALCHEMY Protocol initialized. Enter a research topic and click Run Experiment.', 'info');

  // Bind events
  document.getElementById('run-btn')?.addEventListener('click', runPipeline);
  document.getElementById('register-agent-btn')?.addEventListener('click', registerHolAgent);
  document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);
  document.getElementById('create-campaign-btn')?.addEventListener('click', createCampaignFromFundraising);
  document.getElementById('save-investor-btn')?.addEventListener('click', saveInvestorProfile);
  document.getElementById('match-campaigns-btn')?.addEventListener('click', findFundingMatches);
  document.getElementById('contribution-intent-btn')?.addEventListener('click', createContributionIntent);
  document.getElementById('record-contribution-btn')?.addEventListener('click', recordContribution);
  document.getElementById('chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });

  document.querySelectorAll('.agent-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.agent));
  });

  // Sample topics
  document.querySelectorAll('.sample-topic').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('research-topic').value = el.textContent;
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
