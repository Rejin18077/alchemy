/**
 * ALCHEMY Protocol — IPFS / Pinata Publication Storage
 *
 * When a `RESULT_PUBLISHED` event is fired, pin the full research bundle
 * to IPFS via Pinata. The returned CID is embedded in the NFT metadata
 * and the HCS-10 log entry so the data is permanently addressable.
 *
 * Requires in .env:
 *   PINATA_API_KEY     — Pinata API key
 *   PINATA_API_SECRET  — Pinata API secret
 *
 * Falls back to simulated mode if Pinata credentials are absent.
 */

const fetch = require('node-fetch');

const PINATA_BASE = 'https://api.pinata.cloud';

/**
 * Returns whether Pinata is configured.
 */
function isPinataConfigured() {
  const key = process.env.PINATA_API_KEY;
  const secret = process.env.PINATA_API_SECRET;
  return Boolean(
    key && key.trim() && !['your_pinata_key'].includes(key.trim()) &&
    secret && secret.trim() && !['your_pinata_secret'].includes(secret.trim())
  );
}

/**
 * Tests the Pinata credentials.
 * @returns {Promise<{ authenticated: boolean, error?: string }>}
 */
async function testPinata() {
  if (!isPinataConfigured()) {
    return { authenticated: false, error: 'PINATA_API_KEY / PINATA_API_SECRET not configured' };
  }

  try {
    const res = await fetch(`${PINATA_BASE}/data/testAuthentication`, {
      headers: {
        pinata_api_key: process.env.PINATA_API_KEY,
        pinata_secret_api_key: process.env.PINATA_API_SECRET
      }
    });
    if (res.ok) return { authenticated: true };
    return { authenticated: false, error: `Pinata returned HTTP ${res.status}` };
  } catch (err) {
    return { authenticated: false, error: err.message };
  }
}

/**
 * Pins a JSON object to IPFS via Pinata.
 * @param {object} data         The JSON object to pin
 * @param {string} name         Metadata name for the pin
 * @returns {Promise<{ pinned: boolean, mode: string, cid?: string, gatewayUrl?: string, error?: string }>}
 */
async function pinJsonToIpfs(data, name = 'alchemy-publication') {
  if (!isPinataConfigured()) {
    console.log(`[IPFS] Simulated pin for: ${name}`);
    return {
      pinned: false,
      mode: 'simulated',
      error: 'Pinata not configured — add PINATA_API_KEY and PINATA_API_SECRET to .env'
    };
  }

  try {
    const body = {
      pinataMetadata: { name },
      pinataContent: data
    };

    const res = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        pinata_api_key: process.env.PINATA_API_KEY,
        pinata_secret_api_key: process.env.PINATA_API_SECRET
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errDump = await res.text();
      throw new Error(`Pinata HTTP ${res.status}: ${errDump.slice(0, 200)}`);
    }

    const result = await res.json();
    const cid = result.IpfsHash;
    return {
      pinned: true,
      mode: 'ipfs',
      cid,
      gatewayUrl: `https://gateway.pinata.cloud/ipfs/${cid}`
    };
  } catch (err) {
    console.error(`[IPFS] Pin failed: ${err.message}`);
    return { pinned: false, mode: 'ipfs', error: err.message };
  }
}

/**
 * Builds and pins the full publication bundle for a completed experiment.
 *
 * @param {object} options
 * @param {string} options.experimentId
 * @param {object} options.hypothesis
 * @param {object} options.peerReviewResult
 * @param {object} options.resultsData
 * @param {object} options.hcsEntry     The HCS log entry being generated
 * @returns {Promise<object>}  IPFS result
 */
async function pinPublicationBundle({ experimentId, hypothesis, peerReviewResult, resultsData, hcsEntry }) {
  const bundle = {
    protocol: 'ALCHEMY/1.0',
    experimentId,
    publishedAt: new Date().toISOString(),
    hypothesis: hypothesis || null,
    peerReview: peerReviewResult || null,
    results: resultsData || null,
    hcsReference: {
      topicId: process.env.HCS_TOPIC_ID || null,
      transactionId: hcsEntry?.hedera?.hcs?.transaction_id || null,
      sequenceNumber: hcsEntry?.hedera?.hcs?.sequence_number || null
    }
  };

  return pinJsonToIpfs(bundle, `alchemy-publication-${experimentId}`);
}

/**
 * Returns the IPFS status for the /api/health endpoint.
 */
function getIpfsStatus() {
  return {
    configured: isPinataConfigured(),
    provider: isPinataConfigured() ? 'pinata' : 'not-configured',
    mode: isPinataConfigured() ? 'ipfs' : 'simulated'
  };
}

module.exports = {
  isPinataConfigured,
  testPinata,
  pinJsonToIpfs,
  pinPublicationBundle,
  getIpfsStatus
};
