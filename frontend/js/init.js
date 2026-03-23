// ─── Initialization & Bindings ───────────────────────────────

async function refreshAgentCard() {
  const res = await fetch(`${API_BASE}/api/agent/card`);
  state.agentCard = await res.json();
  
  const el = document.getElementById('agent-card-meta');
  if (!el) return;
  if (!state.agentCard) {
    el.innerHTML = 'Agent card unavailable.';
    return;
  }

  const reg = state.agentCard.registration || {};
  const hcs10 = state.agentCard.reachability?.hcs10 || {};
  el.innerHTML = `
    <div style="margin-bottom:6px"><strong>${escapeHtml(state.agentCard.name || 'ALCHEMY')}</strong></div>
    <div>Status: ${escapeHtml(reg.status || 'unregistered')}</div>
    <div>Chat: ${escapeHtml(state.agentCard.reachability?.naturalLanguageChat || 'n/a')}</div>
    <div>Inbound Topic: ${escapeHtml(hcs10.inboundTopicId || 'not-created')}</div>
    <div style="font-size:9px">UAID: ${escapeHtml(reg.uaid || 'not-assigned')}</div>
  `;
}

async function refreshLaborStatus() {
  const res = await fetch(`${API_BASE}/api/labor/status`);
  const payload = await res.json();
  state.laborStatus = payload.config || null;
  state.laborMarketplaces = payload.marketplaces || [];
}

async function init() {
  updatePipelineBanner('idle');

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
        apiStatus.innerHTML = `<span class="status-dot red"></span> Missing Mistral or Ollama Fallback`;
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

  // Sample topics
  document.querySelectorAll('.sample-topic').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('research-topic').value = el.textContent;
    });
  });

  // Polling for HCS updates
  setInterval(refreshInboundMessages, 15000);
}

document.addEventListener('DOMContentLoaded', init);
