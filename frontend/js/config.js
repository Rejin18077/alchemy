// ─── Global Config & Shared Helpers ─────────────────────────
const API_BASE = window.location.origin;

// Shared Application State
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

// Pipeline step descriptions for the banner
const PIPELINE_STEPS = {
  idle:        { label: 'IDLE',        desc: 'Enter a research topic and click ⚡ Run Experiment to launch the autonomous pipeline.', pct: '0%' },
  hypothesis:  { label: 'STEP 1 / 6',  desc: 'Hypothesis Agent — Searching Semantic Scholar for relevant papers and generating a testable scientific claim…', pct: '10%' },
  peerReview:  { label: 'STEP 2 / 6',  desc: 'Peer Review Agent — 5 independent AI reviewers are evaluating and stress-testing the hypothesis…', pct: '28%' },
  fundraising: { label: 'STEP 3 / 6',  desc: 'Fundraising Agent — Opening a capital pool on Hedera HTS and matching investors to the experiment…', pct: '46%' },
  labor:       { label: 'STEP 4 / 6',  desc: 'Labor Market Agent — Breaking the experiment into bounty tasks and dispatching them via XMTP…', pct: '62%' },
  results:     { label: 'STEP 5 / 6',  desc: 'Results Agent — Compiling findings, pinning to IPFS, archiving to HCS, and minting the Publication NFT…', pct: '80%' },
  replication: { label: 'STEP 6 / 6',  desc: 'Replication Agent — Independently verifying results and updating the NFT reputation score on Hedera…', pct: '95%' },
  done:        { label: 'COMPLETE ✓',   desc: 'Experiment complete! Results are published on Hedera HCS and the Publication NFT has been minted.', pct: '100%' }
};

// Plain-English labels for HCS action types
const HCS_ACTION_LABELS = {
  HYPOTHESIS_GENERATED:   'Novel claim generated from literature',
  REVIEW_COMPLETED:       'Peer council delivered their verdict',
  FUNDING_DECISION:       'Capital pool opened on Hedera HTS',
  TASKS_PUBLISHED:        'Bounty tasks posted to workers',
  TASK_MARKETPLACE_OPENED:'Labor marketplace is accepting bids',
  FUNDING_DECISION_MADE:  'Investment decision recorded',
  RESULT_PUBLISHED:       'Findings archived + NFT minted',
  REPLICATION_DONE:       'Results verified by replication agent',
  INBOUND:                'Message received from the network',
  MESSAGE_RECEIVED:       'Inbound message from another agent',
  UNKNOWN:                'Network event logged'
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function trustLevelFromScore(score) {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  return 'LOW';
}

// Update the pipeline status banner
function updatePipelineBanner(stepKey) {
  const step = PIPELINE_STEPS[stepKey] || PIPELINE_STEPS.idle;
  const labelEl = document.getElementById('banner-step');
  const descEl = document.getElementById('banner-desc');
  const progressEl = document.getElementById('pipeline-progress');
  if (labelEl) labelEl.textContent = step.label;
  if (descEl) descEl.textContent = step.desc;
  if (progressEl) progressEl.style.width = step.pct;
}

// Update the agent status message bar inside an agent card
function setAgentStatusMsg(agentKey, msg) {
  const el = document.getElementById(`status-msg-${agentKey}`);
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="agent-status-spinner"></div>${escapeHtml(msg)}`;
}

// ─── Status Log ──────────────────────────────────────────────
function addStatusMessage(message, type = 'info') {
  const log = document.getElementById('status-log');
  if (!log) return;
  const icons = { info: '◆', success: '✓', error: '✗', hcs: '⬡' };
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-icon">${icons[type] || '◆'}</span><span class="log-msg">${escapeHtml(message)}</span>`;
  log.prepend(entry);
  if (log.children.length > 60) log.removeChild(log.lastChild);
}

// ─── API Helpers ─────────────────────────────────────────────
async function callAgent(agentKey, userMessage, maxTokens = 4096, extra = {}) {
  const agent = AGENTS[agentKey];
  const response = await fetch(`${API_BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentKey, systemPrompt: agent.systemPrompt, userMessage, maxTokens, ...extra })
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

function highlightJSON(obj) {
  const str = JSON.stringify(obj, null, 2);
  return str
    .replace(/(".*?")\s*:/g, '<span class="json-key">$1</span>:')
    .replace(/:\s*(".*?")/g, ': <span class="json-string">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
}

function assessTopicQuality(topic) {
  const text = String(topic || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  let score = 0.2;
  if (tokens.length >= 4) score += 0.3;
  if (tokens.length >= 8) score += 0.2;
  if (text.length >= 40) score += 0.2;
  if (/\?$/.test(text) || /versus|vs|compared|impact|effect|role/.test(text.toLowerCase())) score += 0.1;
  return clamp(score);
}

function switchTab(agentKey) {
  document.querySelectorAll('.agent-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.agent === agentKey));
  document.querySelectorAll('.agent-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.agent === agentKey));
}
