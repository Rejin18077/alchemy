// ─── HCS Messages ───────────────────────────────────────────────

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
  try { return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ts; }
}

async function refreshHCSLog() {
  const res = await fetch(`${API_BASE}/api/hcs/log`);
  state.hcsMessages = await res.json();
  renderHCSLog();
}

function renderHCSLog() {
  const el = document.getElementById('hcs-messages');
  if (!el) return;
  if (state.hcsMessages.length === 0) {
    el.innerHTML = '<div class="empty-state">No messages yet. Run an experiment to see HCS-10 messages flow.</div>';
    return;
  }
  
  el.innerHTML = state.hcsMessages.slice(0, 30).map(m => {
    const rawAction = m.action_type || m.event || 'MESSAGE';
    const readableAction = HCS_ACTION_LABELS[rawAction] || HCS_ACTION_LABELS.UNKNOWN;
    const isInbound = String(rawAction).includes('INBOUND') || String(rawAction).includes('RECEIVED') || m.source === 'inbound';
    
    return `
    <div class="hcs-message ${isInbound ? 'inbound' : 'outbound'}">
      <div class="hcs-msg-header">
        <span class="hcs-direction-badge ${isInbound ? 'in' : 'out'}">${isInbound ? 'IN' : 'OUT'}</span>
        <span class="hcs-agent-badge" style="color:${getAgentColor(m.agent_type)}">${m.agent_type || 'SYSTEM'}</span>
        <span class="hcs-action">${escapeHtml(rawAction)} <span class="hcs-action-label">→ ${readableAction}</span></span>
        <span class="hcs-time">${formatTime(m.timestamp)}</span>
      </div>
      <div class="hcs-msg-id">ID: ${(m.id || m.message_id || '').substring(0, 24)}...</div>
      ${m.experiment_id ? `<div class="hcs-exp-id">EXP: ${escapeHtml(m.experiment_id)}</div>` : ''}
    </div>
  `}).join('');
}

// Inbound polling
let lastInboundCount = 0;

async function refreshInboundMessages() {
  try {
    const res = await fetch(`${API_BASE}/api/hcs/inbound?limit=10`);
    if (!res.ok) return;
    const messages = await res.json();
    if (messages.length > lastInboundCount) {
      const badge = document.getElementById('inbound-badge');
      if (badge) {
        badge.style.display = 'inline-block';
        setTimeout(() => { badge.style.display = 'none'; }, 8000);
      }
      lastInboundCount = messages.length;
      await refreshHCSLog();
      addStatusMessage(`${messages.length} inbound HCS-10 message(s) received from network.`, 'hcs');
    }
  } catch {
    // Silent
  }
}
