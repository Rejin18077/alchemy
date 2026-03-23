const path = require('path');
const { pathToFileURL } = require('url');

const {
  MODEL,
  agentRuntime,
  holRegistry,
  hasConfiguredValue,
  getAgentEnvConfig,
  appendRegistrationProgress
} = require('../core/runtime');
const { markDatabaseDirty } = require('../db/sqlite');

async function loadHolSdk() {
  const sdkUrl = pathToFileURL(
    path.join(process.cwd(), 'node_modules', '@hashgraphonline', 'standards-sdk', 'dist', 'es', 'standards-sdk.es.js')
  ).href;
  return import(sdkUrl);
}

function getHolCapabilityEnums(holSdk) {
  return [
    holSdk.AIAgentCapability.KNOWLEDGE_RETRIEVAL,
    holSdk.AIAgentCapability.SUMMARIZATION_EXTRACTION,
    holSdk.AIAgentCapability.API_INTEGRATION,
    holSdk.AIAgentCapability.MULTI_AGENT_COORDINATION,
    holSdk.AIAgentCapability.WORKFLOW_AUTOMATION
  ];
}

function createAgentProfilePayload(holSdk, createResult, baseUrl) {
  const cfg = getAgentEnvConfig();
  return {
    version: '1.0',
    type: holSdk.ProfileType ? holSdk.ProfileType.AI_AGENT : 1,
    display_name: cfg.name,
    alias: cfg.alias,
    bio: cfg.bio,
    inboundTopicId: createResult.inboundTopicId,
    outboundTopicId: createResult.outboundTopicId,
    profileTopicId: createResult.profileTopicId,
    pfpTopicId: createResult.pfpTopicId,
    properties: {
      dapp_url: baseUrl,
      rest_chat_endpoint: `${baseUrl}/api/chat`,
      discovery_endpoint: `${baseUrl}/.well-known/ai-agent.json`
    },
    aiAgent: {
      type: holSdk.AIAgentType.AUTONOMOUS,
      capabilities: getHolCapabilityEnums(holSdk),
      model: MODEL,
      creator: cfg.creator
    }
  };
}

function createAgentCard(baseUrl) {
  const cfg = getAgentEnvConfig();
  const reg = agentRuntime.registration;
  const registrationState = reg?.status || 'unregistered';

  return {
    id: cfg.alias,
    name: cfg.name,
    alias: cfg.alias,
    bio: cfg.bio,
    creator: cfg.creator,
    registration: {
      status: registrationState,
      uaid: reg?.uaid || null,
      transactionId: reg?.transactionId || null,
      error: agentRuntime.lastRegistrationError,
      progress: agentRuntime.registrationProgress.slice(0, 10)
    },
    reachability: {
      naturalLanguageChat: `${baseUrl}/api/chat`,
      dapp: baseUrl,
      discovery: `${baseUrl}/.well-known/ai-agent.json`,
      hcs10: reg ? {
        inboundTopicId: reg.inboundTopicId || null,
        outboundTopicId: reg.outboundTopicId || null,
        profileTopicId: reg.profileTopicId || null
      } : null,
      mcp: {
        transport: 'sse',
        url: `${baseUrl}/mcp/sse`
      }
    },
    protocols: ['REST', 'HCS-10', 'MCP-SSE'],
    capabilities: [
      'natural-language-chat',
      'scientific-hypothesis-generation',
      'literature-retrieval',
      'hedera-logging',
      'workflow-orchestration'
    ]
  };
}

function buildChatSystemPrompt() {
  return [
    'You are the ALCHEMY Protocol agent.',
    'You help users understand and operate the decentralized scientific workflow in natural language.',
    'Be concise, helpful, and practical.',
    'When relevant, mention that the app supports hypothesis generation, peer review, fundraising, labor planning, results publication, replication, HCS logging, and optional HOL registration.'
  ].join('\n');
}

async function ensureHolAgentRegistration(baseUrl) {
  if (agentRuntime.registration?.status === 'registered' || agentRuntime.registration?.status === 'created-hcs10-only') {
    agentRuntime.agentCard = createAgentCard(baseUrl);
    return agentRuntime.registration;
  }

  agentRuntime.registrationAttempted = true;
  agentRuntime.lastRegistrationError = null;
  appendRegistrationProgress({ stage: 'preparing', message: 'Preparing HOL registration' });

  if (!hasConfiguredValue(process.env.HEDERA_ACCOUNT_ID, ['0.0.XXXXXXX']) || !hasConfiguredValue(process.env.HEDERA_PRIVATE_KEY, ['302e...'])) {
    throw new Error('Real Hedera operator credentials are required for HOL registration');
  }

  const holSdk = await loadHolSdk();
  const cfg = getAgentEnvConfig();
  const client = new holSdk.HCS10Client({
    network: process.env.HEDERA_NETWORK || 'testnet',
    operatorId: process.env.HEDERA_ACCOUNT_ID,
    operatorPrivateKey: process.env.HEDERA_PRIVATE_KEY,
    guardedRegistryBaseUrl: cfg.guardedRegistryBaseUrl,
    silent: true
  });

  const builder = new holSdk.AgentBuilder()
    .setName(cfg.name)
    .setAlias(cfg.alias)
    .setBio(cfg.bio)
    .setCapabilities(getHolCapabilityEnums(holSdk))
    .setType('autonomous')
    .setModel(MODEL)
    .setCreator(cfg.creator)
    .setNetwork(process.env.HEDERA_NETWORK || 'testnet')
    .setInboundTopicType(holSdk.InboundTopicType.PUBLIC);

  appendRegistrationProgress({ stage: 'submitting', message: 'Creating HCS-10 inbound/outbound topics and HCS-11 profile' });
  const createResult = await client.createAgent(builder, 60, undefined, (progress) => {
    appendRegistrationProgress(progress);
  });

  const registration = {
    status: 'created-hcs10-only',
    inboundTopicId: createResult.inboundTopicId,
    outboundTopicId: createResult.outboundTopicId,
    profileTopicId: createResult.profileTopicId,
    pfpTopicId: createResult.pfpTopicId,
    broker: null,
    uaid: null,
    transactionId: null
  };

  if (hasConfiguredValue(process.env.REGISTRY_BROKER_API_KEY, ['rbk_...'])) {
    appendRegistrationProgress({ stage: 'verifying', message: 'Registering agent with HOL Registry Broker' });
    const broker = new holSdk.RegistryBrokerClient({
      apiKey: process.env.REGISTRY_BROKER_API_KEY,
      baseUrl: cfg.guardedRegistryBaseUrl
    });

    const payload = {
      profile: createAgentProfilePayload(holSdk, createResult, baseUrl),
      endpoint: `${baseUrl}/api/chat`,
      protocol: 'hcs-10',
      communicationProtocol: 'hcs-10',
      metadata: {
        provider: 'alchemy-protocol',
        publicUrl: baseUrl,
        nativeId: cfg.alias
      }
    };

    const brokerResponse = await broker.registerAgent(payload);
    registration.broker = brokerResponse;
    registration.status = brokerResponse?.success ? 'registered' : (brokerResponse?.status || 'created-hcs10-only');
    registration.uaid = brokerResponse?.uaid || brokerResponse?.agentId || null;
    registration.transactionId = brokerResponse?.transactionId || brokerResponse?.transaction_id || null;
  }

  agentRuntime.registration = registration;
  holRegistry[cfg.alias] = {
    agent_id: cfg.alias,
    reputation_score: 0.35,
    trust_level: 'LOW',
    contributions: ['hol-registration'],
    owned_experiments: [],
    last_updated: new Date().toISOString(),
    inbound_topic_id: registration.inboundTopicId,
    outbound_topic_id: registration.outboundTopicId,
    profile_topic_id: registration.profileTopicId,
    uaid: registration.uaid
  };
  agentRuntime.agentCard = createAgentCard(baseUrl);
  appendRegistrationProgress({ stage: 'completed', message: 'HOL registration flow completed' });
  markDatabaseDirty();

  return registration;
}

/**
 * Searches the HOL Registry Broker for agents matching given capabilities.
 * Falls back gracefully if the Registry Broker API key is not configured.
 *
 * @param {object} options
 * @param {string[]} [options.capabilities]  Capability enum strings to filter by
 * @param {number}   [options.limit]         Max results
 * @returns {Promise<object[]>}  Array of agent profile objects
 */
async function discoverAgentsFromRegistry(options = {}) {
  if (!hasConfiguredValue(process.env.REGISTRY_BROKER_API_KEY, ['rbk_...'])) {
    throw new Error('Simulation disabled: REGISTRY_BROKER_API_KEY not configured.');
  }

  try {
    const holSdk = await loadHolSdk();
    const cfg = getAgentEnvConfig();
    const broker = new holSdk.RegistryBrokerClient({
      apiKey: process.env.REGISTRY_BROKER_API_KEY,
      baseUrl: cfg.guardedRegistryBaseUrl
    });

    const result = await broker.listAgents({
      capabilities: options.capabilities || [],
      limit: options.limit || 20
    });

    const agents = Array.isArray(result?.agents) ? result.agents : (Array.isArray(result) ? result : []);
    return agents.map(agent => ({
      id: agent.id || agent.agentId || agent.uaid || 'unknown',
      name: agent.profile?.display_name || agent.name || agent.id,
      alias: agent.profile?.alias || agent.alias || null,
      capabilities: agent.profile?.aiAgent?.capabilities || [],
      uaid: agent.uaid || agent.id || null,
      inboundTopicId: agent.profile?.inboundTopicId || null,
      endpoint: agent.endpoint || agent.profile?.properties?.rest_chat_endpoint || null,
      discoveredAt: new Date().toISOString(),
      simulated: false
    }));
  } catch (err) {
    console.error('[HOL Discovery] Failed:', err.message);
    return [];
  }
}

module.exports = {
  loadHolSdk,
  getHolCapabilityEnums,
  createAgentProfilePayload,
  createAgentCard,
  buildChatSystemPrompt,
  ensureHolAgentRegistration,
  discoverAgentsFromRegistry
};
