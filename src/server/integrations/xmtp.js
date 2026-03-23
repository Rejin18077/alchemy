/**
 * ALCHEMY Protocol — XMTP A2A Messaging Integration
 *
 * Provides wallet-to-wallet messaging via the XMTP network for dispatching
 * task assignments, RFPs, and notifications to workers or other agents.
 *
 * Requires:
 *   XMTP_PRIVATE_KEY  — 0x-prefixed Ethereum private key for the agent's XMTP wallet
 *   XMTP_ENABLED      — set to "true" to activate
 *
 * Falls back gracefully when XMTP is not configured (simulated mode).
 */

const { hasConfiguredValue } = require('../core/runtime');

// Lazy-loaded XMTP client singleton
let xmtpClient = null;
let xmtpInitialized = false;
let xmtpError = null;

/**
 * Tries to dynamically load the @xmtp/xmtp-js SDK.
 * Returns the SDK module or null if not installed.
 */
async function loadXmtpSdk() {
  try {
    // Dynamic import for ESM-only package
    return await import('@xmtp/xmtp-js');
  } catch {
    return null;
  }
}

/**
 * Initializes the XMTP client from the configured private key.
 * Runs once and caches the result.
 */
async function initXmtp() {
  if (xmtpInitialized) return;
  xmtpInitialized = true;

  const enabled = String(process.env.XMTP_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) return;

  const privateKey = process.env.XMTP_PRIVATE_KEY;
  if (!hasConfiguredValue(privateKey, ['0x...', 'your_private_key'])) {
    console.warn('[XMTP] XMTP_PRIVATE_KEY is not configured. Running in simulated mode.');
    return;
  }

  const sdk = await loadXmtpSdk();
  if (!sdk) {
    console.warn('[XMTP] @xmtp/xmtp-js SDK not installed. Run: npm install @xmtp/xmtp-js ethers');
    return;
  }

  try {
    const { Client } = sdk;
    // Create a wallet from the private key
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(privateKey);
    const network = (process.env.XMTP_NETWORK || 'dev'); // 'dev' | 'production'
    xmtpClient = await Client.create(wallet, { env: network });
    console.log(`[XMTP] Client initialized for address: ${xmtpClient.address}`);
  } catch (err) {
    xmtpError = err.message;
    console.error(`[XMTP] Initialization failed: ${err.message}`);
  }
}

/**
 * Returns current XMTP status object for health endpoint.
 */
function getXmtpStatus() {
  const enabled = String(process.env.XMTP_ENABLED || 'false').toLowerCase() === 'true';
  return {
    enabled,
    initialized: xmtpInitialized,
    address: xmtpClient?.address || null,
    error: xmtpError || null,
    mode: xmtpClient ? 'xmtp' : 'simulated'
  };
}

/**
 * Sends an XMTP message to an Ethereum address.
 *
 * @param {string} recipientAddress  Ethereum wallet address of the recipient
 * @param {string|object} payload    Message content (string or JSON-serialisable object)
 * @returns {Promise<{ sent: boolean, mode: string, messageId?: string }>}
 */
async function sendXmtpMessage(recipientAddress, payload) {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

  if (!xmtpClient) {
    throw new Error('Simulation disabled: XMTP client not initialized. XMTP_PRIVATE_KEY must be set.');
  }

  try {
    const canMessage = await xmtpClient.canMessage(recipientAddress);
    if (!canMessage) {
      return {
        sent: false,
        mode: 'xmtp',
        reason: `Address ${recipientAddress} is not XMTP-enabled`
      };
    }

    const conversation = await xmtpClient.conversations.newConversation(recipientAddress);
    const sent = await conversation.send(content);

    return {
      sent: true,
      mode: 'xmtp',
      messageId: sent.id,
      recipientAddress
    };
  } catch (err) {
    console.error(`[XMTP] Send failed to ${recipientAddress}: ${err.message}`);
    return { sent: false, mode: 'xmtp', reason: err.message };
  }
}

/**
 * Broadcasts a task assignment to a worker (or their XMTP address).
 * Formats the payload in a structured way for ALCHEMY tasks.
 *
 * @param {object} task
 * @param {object} worker   Must have `xmtpAddress` set
 * @param {object} marketplace
 */
async function dispatchTaskViaXmtp(task, worker, marketplace) {
  if (!worker?.xmtpAddress) {
    throw new Error('Simulation disabled: Worker has no xmtpAddress');
  }

  const message = {
    protocol: 'ALCHEMY-LABOR-DISPATCH/1.0',
    marketplaceId: marketplace.id,
    taskId: task.id,
    title: task.description,
    reward: `${task.reward} ${task.token}`,
    difficulty: task.difficulty,
    successCriteria: task.successCriteria,
    submissionEndpoint: `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/api/labor/tasks/${task.id}/submissions`,
    issuedAt: new Date().toISOString()
  };

  return sendXmtpMessage(worker.xmtpAddress, message);
}

module.exports = {
  initXmtp,
  getXmtpStatus,
  sendXmtpMessage,
  dispatchTaskViaXmtp
};
