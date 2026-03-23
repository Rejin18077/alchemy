/**
 * ALCHEMY Protocol — HCS-10 Inbound Listener
 *
 * Polls the Hedera Mirror Node REST API for new messages on the agent's
 * inbound HCS-10 topic and processes them as A2A commands or chat requests.
 */

const fetch = require('node-fetch');

const {
  getHederaMode,
  agentRuntime,
  hcsLog,
  hasConfiguredValue
} = require('../core/runtime');
const { markDatabaseDirty } = require('../db/sqlite');

/** In-memory store for inbound messages received from other agents */
const inboundMessages = [];

let pollingInterval = null;
let lastTimestamp = null;

/**
 * Fetches new messages for a given HCS topic from the Mirror Node REST API.
 * @param {string} topicId
 * @param {string|null} afterTimestamp  consensus_timestamp to page from
 * @returns {Promise<object[]>}
 */
async function fetchTopicMessages(topicId, afterTimestamp) {
  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  const mirrorBase =
    process.env.HEDERA_MIRROR_NODE_URL ||
    (network === 'mainnet'
      ? 'https://mainnet-public.mirrornode.hedera.com/api/v1'
      : 'https://testnet.mirrornode.hedera.com/api/v1');

  let url = `${mirrorBase}/topics/${encodeURIComponent(topicId)}/messages?limit=25&order=asc`;
  if (afterTimestamp) {
    url += `&timestamp=gt:${encodeURIComponent(afterTimestamp)}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Mirror Node replied ${res.status} for topic ${topicId}`);
  }

  const json = await res.json();
  return json.messages || [];
}

/**
 * Decodes a base64-encoded HCS message into a JS object.
 * Returns a { raw, parsed } pair.
 */
function decodeMessage(message) {
  try {
    const raw = Buffer.from(message.message, 'base64').toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { text: raw };
    }
    return { raw, parsed };
  } catch {
    return { raw: '', parsed: {} };
  }
}

/**
 * Processes a single inbound HCS message.
 */
function processInboundMessage(message, topicId) {
  const { raw, parsed } = decodeMessage(message);

  const entry = {
    id: `inbound-${message.sequence_number}-${topicId}`,
    direction: 'INBOUND',
    source: 'hcs-10',
    topicId,
    sequenceNumber: message.sequence_number,
    consensusTimestamp: message.consensus_timestamp,
    payer: message.payer_account_id || null,
    raw,
    parsed,
    // Detect if this is an A2A task dispatch or a natural-language message
    messageType: parsed?.action_type || parsed?.type || 'UNKNOWN',
    processedAt: new Date().toISOString()
  };

  inboundMessages.unshift(entry);
  if (inboundMessages.length > 50) inboundMessages.pop();

  // Also append to the shared HCS log so it appears in the UI
  hcsLog.unshift({
    ...entry,
    agent_type: 'INBOUND',
    action_type: entry.messageType,
    timestamp: new Date().toISOString(),
    event: 'MESSAGE_RECEIVED'
  });
  if (hcsLog.length > 100) hcsLog.pop();

  markDatabaseDirty();
  return entry;
}

/**
 * One polling tick: fetches new messages on both the agent's inbound topic
 * and the primary HCS_TOPIC_ID (if different).
 */
async function pollOnce() {
  const mode = getHederaMode();
  if (mode.hcs !== 'enabled') return;

  // Collect topic IDs to poll
  const topics = new Set();

  if (hasConfiguredValue(process.env.HCS_TOPIC_ID, ['0.0.XXXXXXX'])) {
    topics.add(process.env.HCS_TOPIC_ID.trim());
  }

  // If the agent has been registered, poll its dedicated inbound topic too
  const inboundTopicId = agentRuntime.registration?.inboundTopicId;
  if (inboundTopicId) {
    topics.add(inboundTopicId);
  }

  for (const topicId of topics) {
    try {
      const messages = await fetchTopicMessages(topicId, lastTimestamp);
      if (messages.length > 0) {
        for (const msg of messages) {
          processInboundMessage(msg, topicId);
        }
        // Advance the cursor to the latest consensus timestamp
        const newest = messages[messages.length - 1];
        lastTimestamp = newest.consensus_timestamp;
      }
    } catch (err) {
      // Silent — mirror node may be temporarily unavailable
      if (process.env.DEBUG_HCS_LISTENER === 'true') {
        console.warn(`[HCS Listener] Poll error for topic ${topicId}: ${err.message}`);
      }
    }
  }
}

/**
 * Starts the periodic poller.
 * @param {number} intervalMs  How often to poll (default: 15 seconds)
 */
function startHcsListener(intervalMs = 15000) {
  if (pollingInterval) return; // Already started

  const mode = getHederaMode();
  if (mode.hcs !== 'enabled') {
    console.log('[HCS Listener] Skipping — HCS is in simulated mode. Configure HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, and HCS_TOPIC_ID to enable.');
    return;
  }

  console.log(`[HCS Listener] Starting — polling every ${intervalMs / 1000}s for inbound messages.`);

  // Initial poll immediately, then on interval
  pollOnce().catch(() => {});
  pollingInterval = setInterval(() => {
    pollOnce().catch(() => {});
  }, intervalMs);
}

/**
 * Stops the poller (called during graceful shutdown).
 */
function stopHcsListener() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[HCS Listener] Stopped.');
  }
}

/**
 * Returns the current list of received inbound messages.
 */
function getInboundMessages(limit = 20) {
  return inboundMessages.slice(0, limit);
}

module.exports = {
  startHcsListener,
  stopHcsListener,
  getInboundMessages,
  pollOnce
};
