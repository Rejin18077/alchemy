// ─── HOL Registry & Agent Discovery ─────────────────────────────

async function refreshHOLRegistry() {
  const res = await fetch(`${API_BASE}/api/hol/registry`);
  state.holRegistry = await res.json();
  renderHOLRegistry();
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
    const color = a.trust_level === 'HIGH' ? '#10d97f' : a.trust_level === 'MEDIUM' ? '#ffb547' : '#ff4d6a';
    return `
      <div class="hol-agent">
        <div class="hol-agent-header">
          <span class="hol-agent-id">${escapeHtml(a.agent_id)}</span>
          <span class="hol-trust" style="color:${color}">${escapeHtml(a.trust_level || 'UNKNOWN')}</span>
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

// Renders the Agent Card meta box in the left panel
function renderAgentCard() {
  const el = document.getElementById('agent-card-meta');
  if (!el || !state.agentCard) return;
  const card = state.agentCard;
  const reg = card.registration || {};
  const hcs10 = card.reachability?.hcs10 || {};
  el.innerHTML = `
    <div style="margin-bottom:6px"><strong>${escapeHtml(card.name || 'ALCHEMY')}</strong></div>
    <div>Status: ${escapeHtml(reg.status || 'unregistered')}</div>
    <div>Chat: ${escapeHtml(card.reachability?.naturalLanguageChat || 'n/a')}</div>
    <div>Inbound Topic: ${escapeHtml(hcs10.inboundTopicId || 'not-created')}</div>
    <div style="font-size:9px">UAID: ${escapeHtml(reg.uaid || 'not-assigned')}</div>
  `;
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

async function discoverAgents() {
  const container = document.getElementById('discovered-agents-list');
  const btn = document.getElementById('discover-btn');
  if (!container) return;

  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  container.innerHTML = '<div class="waiting">Querying HOL Registry Broker...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/hol/discover?limit=15`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Discovery failed');

    const agents = payload.agents || [];
    if (agents.length === 0) {
      container.innerHTML = '<div class="empty-state">No agents found in registry.</div>';
      return;
    }

    container.innerHTML = agents.map(agent => `
      <div class="discovered-agent">
        <div class="discovered-agent-name">
          ${escapeHtml(agent.name || agent.id)}
          ${agent.simulated ? '<span style="color:var(--text-muted);font-size:8px;"> (sim)</span>' : ''}
        </div>
        <div class="discovered-agent-meta">
          ${agent.alias ? `@${escapeHtml(agent.alias)} · ` : ''}
          ${agent.inboundTopicId ? `HCS: ${escapeHtml(agent.inboundTopicId)}` : 'No HCS topic'}
        </div>
        ${agent.capabilities?.length ? `<div class="discovered-agent-caps">${agent.capabilities.slice(0, 3).map(c => escapeHtml(String(c))).join(' · ')}</div>` : ''}
      </div>
    `).join('');

    addStatusMessage(`Discovered ${agents.length} agent(s) from HOL Registry.`, 'success');
  } catch (err) {
    container.innerHTML = `<div class="error-msg">Discovery failed: ${escapeHtml(err.message)}</div>`;
    addStatusMessage(`Agent discovery failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
  }
}
