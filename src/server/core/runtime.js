const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..', '..', '..');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MODEL = process.env.MODEL || 'mistral-large-latest';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const BGE_MODEL = process.env.BGE_MODEL || 'BAAI/bge-small-en-v1.5';
const SEMANTIC_SCHOLAR_API = 'https://api.semanticscholar.org/graph/v1';
const DEFAULT_PAPER_LIMIT = Number(process.env.SEMANTIC_SCHOLAR_LIMIT || 8);
const PEER_REVIEW_PAPER_LIMIT = Number(process.env.PEER_REVIEW_PAPER_LIMIT || 10);
const PEER_REVIEW_RETRIEVAL_COUNT = Number(process.env.PEER_REVIEW_RETRIEVAL_COUNT || 5);

const hcsLog = [];
const holRegistry = {};
const researchCache = new Map();
const agentRuntime = {
  registration: null,
  agentCard: null,
  registrationProgress: [],
  lastRegistrationError: null,
  registrationAttempted: false,
  chatHistory: []
};
const hederaState = {
  expTokenId: process.env.HTS_EXP_TOKEN_ID || null,
  publicationTokenId: process.env.HTS_PUBLICATION_TOKEN_ID || null
};
const fundingState = {
  campaigns: new Map(),
  investors: new Map(),
  contributions: []
};
const laborState = {
  marketplaces: new Map(),
  tasks: new Map(),
  workers: new Map(),
  submissions: []
};
const resultsState = {
  registry: new Map(),
  bundles: new Map()
};
const replicationState = {
  marketplaces: new Map(),
  tasks: new Map(),
  workers: new Map(),
  submissions: []
};

const RESULTS_REGISTRY_FILE = path.join(projectRoot, 'data', 'results-registry.json');
const RESULTS_BUNDLES_FILE = path.join(projectRoot, 'data', 'results-bundles.json');

const PEER_REVIEWERS = [
  {
    key: 'validity',
    identity: 'reviewer-validity-001',
    title: 'Validity Reviewer',
    focus: 'logical consistency, causal validity, confounders, and realism of assumptions'
  },
  {
    key: 'testability',
    identity: 'reviewer-testability-001',
    title: 'Testability Reviewer',
    focus: 'clarity of variables, falsifiability, measurable outcomes, and evaluation rigor'
  },
  {
    key: 'novelty',
    identity: 'reviewer-novelty-001',
    title: 'Novelty Reviewer',
    focus: 'originality, non-trivial contribution, and differentiation from prior literature'
  },
  {
    key: 'feasibility',
    identity: 'reviewer-feasibility-001',
    title: 'Feasibility Reviewer',
    focus: 'availability of data, compute, implementation scope, and operational complexity'
  },
  {
    key: 'impact',
    identity: 'reviewer-impact-001',
    title: 'Impact Reviewer',
    focus: 'scientific significance, downstream usefulness, scalability, and expected benefit'
  }
];

function hasConfiguredValue(value, placeholders = []) {
  if (!value) {
    return false;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return false;
  }

  return !placeholders.includes(normalized);
}

if (!hasConfiguredValue(hederaState.expTokenId, ['0.0.XXXXXXX'])) {
  hederaState.expTokenId = null;
}

if (!hasConfiguredValue(hederaState.publicationTokenId, ['0.0.XXXXXXX'])) {
  hederaState.publicationTokenId = null;
}

function loadHederaSdk() {
  try {
    return require('@hashgraph/sdk');
  } catch {
    return null;
  }
}

function getHederaMode() {
  const sdk = loadHederaSdk();
  const hasOperator =
    hasConfiguredValue(process.env.HEDERA_ACCOUNT_ID, ['0.0.XXXXXXX']) &&
    hasConfiguredValue(process.env.HEDERA_PRIVATE_KEY, ['302e...']);
  const hasTopic = hasConfiguredValue(process.env.HCS_TOPIC_ID, ['0.0.XXXXXXX']);

  return {
    sdk_installed: Boolean(sdk),
    operator_configured: hasOperator,
    network: process.env.HEDERA_NETWORK || 'testnet',
    hcs: sdk && hasOperator && hasTopic ? 'enabled' : 'simulated',
    hts: sdk && hasOperator ? 'enabled' : 'simulated',
    topic_id: process.env.HCS_TOPIC_ID || 'not-configured',
    exp_token_id: hederaState.expTokenId || 'auto-create-if-enabled',
    publication_token_id: hederaState.publicationTokenId || 'auto-create-if-enabled'
  };
}

function getInferenceStatus() {
  return {
    mistral: hasConfiguredValue(MISTRAL_API_KEY, ['your_mistral_api_key_here']) ? 'configured' : 'missing',
    ollama_base_url: OLLAMA_BASE_URL,
    ollama_model: OLLAMA_MODEL,
    bge_model: BGE_MODEL
  };
}

function getAgentEnvConfig() {
  return {
    name: process.env.AGENT_NAME || 'ALCHEMY Protocol Agent',
    alias: process.env.AGENT_ALIAS || 'alchemy_protocol',
    bio: process.env.AGENT_BIO || 'Autonomous scientific research agent with grounded literature retrieval, experiment orchestration, and Hedera-native logging.',
    creator: process.env.AGENT_CREATOR || 'ALCHEMY Protocol',
    publicAppUrl: process.env.PUBLIC_APP_URL || null,
    guardedRegistryBaseUrl: process.env.GUARDED_REGISTRY_BASE_URL || undefined,
    autoRegister: String(process.env.AUTO_REGISTER_AGENT || 'false').toLowerCase() === 'true'
  };
}

function getPublicBaseUrl(req) {
  return getAgentEnvConfig().publicAppUrl || `${req.protocol}://${req.get('host')}`;
}

function appendRegistrationProgress(entry) {
  agentRuntime.registrationProgress.unshift({
    timestamp: new Date().toISOString(),
    ...entry
  });
  if (agentRuntime.registrationProgress.length > 40) {
    agentRuntime.registrationProgress.pop();
  }
}

function parseTokenAmount(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) {
      return Math.max(0, Math.round(Number(match[0])));
    }
  }

  return fallback;
}

function parseCurrencyAmount(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) {
      return Number(match[0]);
    }
  }

  return fallback;
}

function parseTinybarAmount(value, fallback = 0) {
  const numeric = parseCurrencyAmount(value, fallback);
  return Math.max(0, Math.round(numeric));
}

function getFundingConfig() {
  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  return {
    treasuryAccountId: process.env.FUNDRAISING_TREASURY_ACCOUNT_ID || process.env.HEDERA_ACCOUNT_ID || null,
    acceptedAsset: process.env.FUNDRAISING_ACCEPTED_ASSET || 'HBAR',
    usdPerHbar: Number(process.env.FUNDRAISING_USD_PER_HBAR || 0.1),
    minContributionUsd: Number(process.env.FUNDRAISING_MIN_CONTRIBUTION_USD || 25),
    mirrorNodeBaseUrl: process.env.HEDERA_MIRROR_NODE_URL || (network === 'mainnet'
      ? 'https://mainnet-public.mirrornode.hedera.com/api/v1'
      : 'https://testnet.mirrornode.hedera.com/api/v1'),
    matchingEnabled: String(process.env.FUNDRAISING_MATCHING_ENABLED || 'true').toLowerCase() === 'true',
    matchingCapUsd: Number(process.env.FUNDRAISING_MATCHING_CAP_USD || 2500),
    autoReleaseEnabled: String(process.env.FUNDRAISING_AUTO_RELEASE || 'false').toLowerCase() === 'true'
  };
}

function getLaborConfig() {
  return {
    xmtpEnabled: String(process.env.XMTP_ENABLED || 'false').toLowerCase() === 'true',
    xmtpTopic: process.env.XMTP_TOPIC || '',
    payoutAsset: process.env.LABOR_PAYOUT_ASSET || 'EXP',
    payoutMultiplier: Number(process.env.LABOR_PAYOUT_MULTIPLIER || 1),
    verificationMode: process.env.LABOR_VERIFICATION_MODE || 'agent-review'
  };
}

function getFundraisingStatus() {
  const cfg = getFundingConfig();
  return {
    treasury_account_id: cfg.treasuryAccountId || 'not-configured',
    accepted_asset: cfg.acceptedAsset,
    mirror_node_base_url: cfg.mirrorNodeBaseUrl,
    matching_enabled: cfg.matchingEnabled,
    matching_cap_usd: cfg.matchingCapUsd,
    auto_release_enabled: cfg.autoReleaseEnabled,
    campaign_count: fundingState.campaigns.size,
    investor_count: fundingState.investors.size,
    contribution_count: fundingState.contributions.length
  };
}

function getLaborStatus() {
  const cfg = getLaborConfig();
  return {
    xmtp_enabled: cfg.xmtpEnabled,
    xmtp_topic: cfg.xmtpTopic || 'not-configured',
    payout_asset: cfg.payoutAsset,
    verification_mode: cfg.verificationMode,
    marketplace_count: laborState.marketplaces.size,
    task_count: laborState.tasks.size,
    worker_count: laborState.workers.size,
    submission_count: laborState.submissions.length
  };
}

function getResultsStatus() {
  return {
    registry_count: resultsState.registry.size,
    bundle_count: resultsState.bundles.size
  };
}

function getReplicationStatus() {
  return {
    marketplace_count: replicationState.marketplaces.size,
    task_count: replicationState.tasks.size,
    worker_count: replicationState.workers.size,
    submission_count: replicationState.submissions.length
  };
}

async function ensureDataDir() {
  await fs.promises.mkdir(path.join(projectRoot, 'data'), { recursive: true });
}

async function persistResultsState() {
  await ensureDataDir();
  await fs.promises.writeFile(
    RESULTS_REGISTRY_FILE,
    JSON.stringify(Array.from(resultsState.registry.values()), null, 2),
    'utf8'
  );
  await fs.promises.writeFile(
    RESULTS_BUNDLES_FILE,
    JSON.stringify(Array.from(resultsState.bundles.entries()), null, 2),
    'utf8'
  );
}

async function loadResultsState() {
  try {
    const registryRaw = await fs.promises.readFile(RESULTS_REGISTRY_FILE, 'utf8');
    const registryRecords = JSON.parse(registryRaw);
    resultsState.registry.clear();
    for (const record of registryRecords) {
      if (record?.experimentId) {
        resultsState.registry.set(record.experimentId, record);
      }
    }
  } catch {
    // No persisted registry yet.
  }

  try {
    const bundlesRaw = await fs.promises.readFile(RESULTS_BUNDLES_FILE, 'utf8');
    const bundleEntries = JSON.parse(bundlesRaw);
    resultsState.bundles.clear();
    for (const [key, value] of bundleEntries) {
      resultsState.bundles.set(key, value);
    }
  } catch {
    // No persisted bundles yet.
  }
}

function makeCampaignId() {
  return `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeMarketplaceId() {
  return `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeLaborSubmissionId() {
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeReplicationTaskId() {
  return `repl-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeReplicationMarketplaceId() {
  return `repl-mkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeReplicationSubmissionId() {
  return `repl-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeContributionId() {
  return `ctr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveCampaignGoalUsd(fundingResult) {
  const fromPitch = parseCurrencyAmount(fundingResult?.pitch?.funding_required, 0);
  const fromRequired = parseCurrencyAmount(fundingResult?.funding_status?.required, 0);
  const fromRaised = parseCurrencyAmount(fundingResult?.funding_status?.total_raised, 0);
  return Math.max(fromPitch, fromRequired, fromRaised, 1000);
}

function toTinybarFromUsd(usdAmount) {
  const { usdPerHbar } = getFundingConfig();
  const hbar = usdPerHbar > 0 ? usdAmount / usdPerHbar : usdAmount;
  return Math.max(0, Math.round(hbar * 100000000));
}

function fromTinybarToHbar(tinybar) {
  return Number((tinybar / 100000000).toFixed(8));
}

function getCampaignRiskLevel(fundingResult) {
  return String(
    fundingResult?.risk?.level ||
    fundingResult?.pitch?.risk_level ||
    'medium'
  ).toLowerCase();
}

function serializeCampaign(campaign) {
  return {
    ...campaign,
    investors: Array.from(campaign.investors.values()),
    contributions: campaign.contributions.slice(-25)
  };
}

function normalizeTaskReward(value) {
  const parsed = parseTokenAmount(value, 0);
  return parsed > 0 ? parsed : Math.max(1, Math.round(parseCurrencyAmount(value, 25)));
}

function ensureTaskArray(laborResult) {
  return Array.isArray(laborResult?.tasks) ? laborResult.tasks : [];
}

function serializeTask(task) {
  return {
    ...task,
    claims: task.claims.slice(-10),
    submissions: task.submissions.slice(-10)
  };
}

function serializeMarketplace(marketplace) {
  return {
    ...marketplace,
    tasks: marketplace.taskIds.map((taskId) => serializeTask(laborState.tasks.get(taskId))).filter(Boolean)
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseMetricValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) {
      return Number(match[0]);
    }
  }

  return null;
}

module.exports = {
  projectRoot,
  MISTRAL_API_KEY,
  MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  BGE_MODEL,
  SEMANTIC_SCHOLAR_API,
  DEFAULT_PAPER_LIMIT,
  PEER_REVIEW_PAPER_LIMIT,
  PEER_REVIEW_RETRIEVAL_COUNT,
  hcsLog,
  holRegistry,
  researchCache,
  agentRuntime,
  hederaState,
  fundingState,
  laborState,
  resultsState,
  replicationState,
  PEER_REVIEWERS,
  hasConfiguredValue,
  loadHederaSdk,
  getHederaMode,
  getInferenceStatus,
  getAgentEnvConfig,
  getPublicBaseUrl,
  appendRegistrationProgress,
  parseTokenAmount,
  parseCurrencyAmount,
  parseTinybarAmount,
  getFundingConfig,
  getLaborConfig,
  getFundraisingStatus,
  getLaborStatus,
  getResultsStatus,
  getReplicationStatus,
  persistResultsState,
  loadResultsState,
  makeCampaignId,
  makeMarketplaceId,
  makeLaborSubmissionId,
  makeReplicationTaskId,
  makeReplicationMarketplaceId,
  makeReplicationSubmissionId,
  makeContributionId,
  deriveCampaignGoalUsd,
  toTinybarFromUsd,
  fromTinybarToHbar,
  getCampaignRiskLevel,
  serializeCampaign,
  normalizeTaskReward,
  ensureTaskArray,
  serializeTask,
  serializeMarketplace,
  safeJsonParse,
  parseMetricValue
};
