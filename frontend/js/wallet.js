// ─── Wallet Connection ─────────────────────────────────────────

const walletState = { connected: false, accountId: null };

async function connectWallet() {
  const btn = document.getElementById('wallet-btn');
  const label = document.getElementById('wallet-label');
  const icon = document.getElementById('wallet-icon');

  if (walletState.connected) {
    walletState.connected = false;
    walletState.accountId = null;
    btn.classList.remove('connected');
    label.textContent = 'Connect Wallet';
    icon.textContent = '⬡';
    addStatusMessage('Wallet disconnected.', 'info');
    return;
  }

  try {
    label.textContent = 'Connecting...';
    btn.disabled = true;

    // Try HashConnect if available (injected by browser extension)
    let accountId = null;
    if (typeof HashConnect !== 'undefined') {
      try {
        const hc = new HashConnect();
        const initData = await hc.init({ name: 'ALCHEMY Protocol', description: 'Scientific Research Agent' }, 'testnet', true);
        accountId = initData?.savedPairings?.[0]?.accountIds?.[0] || null;
      } catch (hcErr) {
        console.warn('HashConnect init failed, falling back to manual entry:', hcErr.message);
      }
    }

    if (!accountId) {
      accountId = prompt('Enter your Hedera Account ID (e.g. 0.0.12345):');
      if (!accountId || accountId.trim().length === 0) {
        throw new Error('Hedera account ID cannot be empty');
      }
      accountId = accountId.trim();
    }

    walletState.connected = true;
    walletState.accountId = accountId;
    btn.classList.add('connected');
    label.textContent = accountId;
    icon.textContent = '●';
    btn.disabled = false;

    // Pre-fill investor account field if empty
    const investorField = document.getElementById('investor-account');
    if (investorField && !investorField.value) investorField.value = accountId;

    addStatusMessage(`Wallet connected: ${accountId}`, 'success');
  } catch (err) {
    btn.disabled = false;
    label.textContent = 'Connect Wallet';
    icon.textContent = '⬡';
    addStatusMessage(`Wallet connection failed: ${err.message}`, 'error');
  }
}
