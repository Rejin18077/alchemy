// ─── Natural Language Chat ──────────────────────────────────────

async function refreshChatHistory() {
  const res = await fetch(`${API_BASE}/api/chat/history`);
  state.chatHistory = await res.json();
  renderChatHistory();
}

function renderChatHistory() {
  const el = document.getElementById('chat-log');
  if (!el) return;
  if (!state.chatHistory.length) {
    el.innerHTML = '<div class="empty-state">Ask the agent about experiments, HCS-10, HOL registration, or how to use this dApp...</div>';
    return;
  }

  el.innerHTML = state.chatHistory.slice(-10).map(entry => {
    let contentHTML = escapeHtml(entry.content || '');
    if (typeof marked !== 'undefined') {
      contentHTML = marked.parse(entry.content || '');
    }
    return `
      <div class="chat-msg">
        <div class="chat-role">${escapeHtml(entry.role || 'assistant')}</div>
        <div class="chat-content markdown-body">${contentHTML}</div>
      </div>
    `;
  }).join('');
  el.scrollTop = el.scrollHeight;
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
      btn.textContent = 'Send Message';
    }
  }
}

function toggleChatModal() {
  const modal = document.getElementById('chat-modal');
  const overlay = document.getElementById('chat-modal-overlay');
  if (modal && overlay) {
    modal.classList.toggle('visible');
    overlay.classList.toggle('visible');
    if (modal.classList.contains('visible')) {
      document.getElementById('chat-input')?.focus();
    }
  }
}
