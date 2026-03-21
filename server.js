require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { registerFundingRoutes } = require('./src/server/routes/fundraising');
const { registerLaborRoutes } = require('./src/server/routes/labor');
const { registerResultsRoutes } = require('./src/server/routes/results');
const {
  projectRoot,
  MISTRAL_API_KEY,
  MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  BGE_MODEL,
  PEER_REVIEWERS,
  hcsLog,
  holRegistry,
  agentRuntime,
  hederaState,
  fundingState,
  laborState,
  resultsState,
  replicationState,
  hasConfiguredValue,
  appendRegistrationProgress,
  loadHederaSdk,
  getHederaMode,
  getInferenceStatus,
  getAgentEnvConfig,
  getPublicBaseUrl,
  getFundingConfig,
  getLaborConfig,
  getFundraisingStatus,
  getLaborStatus,
  getResultsStatus,
  getReplicationStatus,
  loadResultsState,
  makeCampaignId,
  makeMarketplaceId,
  makeContributionId,
  parseTokenAmount,
  parseCurrencyAmount,
  parseTinybarAmount,
  toTinybarFromUsd,
  fromTinybarToHbar,
  deriveCampaignGoalUsd,
  getCampaignRiskLevel,
  serializeCampaign,
  normalizeTaskReward,
  ensureTaskArray,
  serializeTask,
  serializeMarketplace
} = require('./src/server/core/runtime');
const {
  createAgentCard,
  buildChatSystemPrompt,
  ensureHolAgentRegistration
} = require('./src/server/integrations/hol');
const {
  fetchSemanticScholarPapers,
  rerankPapersWithBge,
  summarizeHypothesis,
  buildHypothesisResearchContext,
  buildHypothesisUserMessage,
  buildPeerReviewResearchContext,
  buildPeerReviewReviewerPrompt
} = require('./src/server/agents/research');
const {
  tryParseModelJson,
  runAgentModelChain
} = require('./src/server/integrations/inference');
const {
  createHederaClient,
  submitMessageToHCS,
  ensureExpToken,
  syncHTSForEntry
} = require('./src/server/integrations/hedera');
const {
  createResultsWorkflow
} = require('./src/server/workflows/results');
const {
  initializeDatabase,
  markDatabaseDirty,
  startDatabaseAutosave,
  shutdownDatabase,
  getDatabaseStatus
} = require('./src/server/db/sqlite');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));



function upsertWorkerProfile(profile) {
  const accountId = String(profile.accountId || '').trim();
  if (!accountId) {
    throw new Error('accountId is required');
  }

  const worker = {
    accountId,
    displayName: String(profile.displayName || accountId),
    alias: profile.alias ? String(profile.alias) : null,
    workerType: String(profile.workerType || 'human').toLowerCase(),
    skills: Array.isArray(profile.skills) ? profile.skills.map(String) : [],
    xmtpAddress: profile.xmtpAddress ? String(profile.xmtpAddress) : null,
    walletProvider: profile.walletProvider ? String(profile.walletProvider) : null,
    hederaAccountId: accountId,
    updatedAt: new Date().toISOString()
  };

  laborState.workers.set(accountId, worker);
  markDatabaseDirty();
  return worker;
}

function createLaborMarketplace({ experimentId, hypothesis, laborResult }) {
  const tasks = ensureTaskArray(laborResult);
  const marketplace = {
    id: makeMarketplaceId(),
    experimentId: experimentId || `exp-${Date.now()}`,
    title: `Labor marketplace for ${summarizeHypothesis(hypothesis).slice(0, 80)}`,
    createdAt: new Date().toISOString(),
    payoutAsset: getLaborConfig().payoutAsset,
    xmtpEnabled: getLaborConfig().xmtpEnabled,
    taskIds: []
  };

  tasks.forEach((task, index) => {
    const taskId = String(task.task_id || `task-${index + 1}`);
    const normalizedTask = {
      id: taskId,
      marketplaceId: marketplace.id,
      experimentId: marketplace.experimentId,
      description: String(task.description || `Task ${index + 1}`),
      input: task.input || '',
      output: task.output || '',
      successCriteria: task.success_criteria || '',
      difficulty: String(task.difficulty || 'medium').toLowerCase(),
      timeEstimate: task.time_estimate || '',
      reward: normalizeTaskReward(task.reward),
      token: task.token || `${getLaborConfig().payoutAsset}_TOKEN`,
      status: 'OPEN',
      assignedWorkerAccountId: null,
      claims: [],
      submissions: [],
      verification: null,
      payout: null,
      dispatch: {
        channel: getLaborConfig().xmtpEnabled ? 'XMTP' : 'REST',
        topic: getLaborConfig().xmtpTopic || null,
        prepared: true
      }
    };
    laborState.tasks.set(taskId, normalizedTask);
    marketplace.taskIds.push(taskId);
  });

  laborState.marketplaces.set(marketplace.id, marketplace);
  markDatabaseDirty();
  return marketplace;
}

async function logLaborEvent(entry) {
  const event = {
    ...entry,
    timestamp: new Date().toISOString(),
    id: `hcs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };

  try {
    const [hcsResult, htsResult] = await Promise.all([
      submitMessageToHCS(event),
      syncHTSForEntry(event)
    ]);
    event.hedera = { hcs: hcsResult, hts: htsResult };
  } catch (err) {
    event.hedera = {
      error: err.message,
      hcs: { mode: 'simulated', submitted: false },
      hts: { mode: 'simulated', executed: false }
    };
  }

  hcsLog.unshift(event);
  if (hcsLog.length > 100) {
    hcsLog.pop();
  }
  markDatabaseDirty();
  return event;
}

async function transferExpToWorker(workerAccountId, amount) {
  const sdk = loadHederaSdk();
  const mode = getHederaMode();
  if (!sdk || mode.hts !== 'enabled') {
    return { mode: 'simulated', transferred: false, reason: 'HTS not fully configured' };
  }

  const { client, privateKey } = createHederaClient(sdk);
  try {
    const tokenId = await ensureExpToken(client, sdk, privateKey);
    const transferTx = await new sdk.TransferTransaction()
      .addTokenTransfer(tokenId, process.env.HEDERA_ACCOUNT_ID, -Math.abs(amount))
      .addTokenTransfer(tokenId, workerAccountId, Math.abs(amount))
      .freezeWith(client)
      .sign(privateKey);
    const submit = await transferTx.execute(client);
    const receipt = await submit.getReceipt(client);
    return {
      mode: 'hedera',
      transferred: true,
      token_id: tokenId,
      transaction_id: submit.transactionId.toString(),
      status: receipt.status.toString()
    };
  } finally {
    client.close();
  }
}

const {
  serializeReplicationTask,
  serializeReplicationMarketplace,
  upsertReplicationWorker,
  createReplicationMarketplace,
  buildResultsExecutionPayload,
  buildReplicationExecutionPayload
} = createResultsWorkflow({
  runAgentModelChain,
  tryParseModelJson,
  transferExpToWorker,
  createHederaClient
});

function updateCampaignStatus(campaign) {
  if (campaign.released) {
    campaign.status = 'RELEASED';
    return campaign;
  }

  if (campaign.raisedUsd >= campaign.goalUsd) {
    campaign.status = 'FUNDED';
  } else if (campaign.raisedUsd > 0) {
    campaign.status = 'ACTIVE';
  } else {
    campaign.status = 'OPEN';
  }

  return campaign;
}

function createCampaignFromFundingResult({
  experimentId,
  hypothesis,
  fundingResult,
  createdBy = 'fundraising-agent'
}) {
  const cfg = getFundingConfig();
  const goalUsd = deriveCampaignGoalUsd(fundingResult);
  const campaign = {
    id: makeCampaignId(),
    experimentId: experimentId || `exp-${Date.now()}`,
    title: fundingResult?.pitch?.title || hypothesis?.statement || 'ALCHEMY Research Campaign',
    description: fundingResult?.pitch?.problem || hypothesis?.statement || 'Research campaign created by the fundraising agent.',
    solution: fundingResult?.pitch?.solution || fundingResult?.impact?.description || '',
    expectedOutcome: fundingResult?.pitch?.expected_outcome || hypothesis?.expected_outcome || '',
    riskLevel: getCampaignRiskLevel(fundingResult),
    impactScore: Number(fundingResult?.impact?.score) || null,
    successProbability: fundingResult?.success_probability || null,
    treasuryAccountId: cfg.treasuryAccountId,
    acceptedAsset: cfg.acceptedAsset,
    matchingEnabled: cfg.matchingEnabled,
    matchingCapUsd: cfg.matchingCapUsd,
    goalUsd,
    goalTinybar: toTinybarFromUsd(goalUsd),
    raisedUsd: parseCurrencyAmount(fundingResult?.funding_status?.total_raised, 0),
    raisedTinybar: 0,
    createdBy,
    createdAt: new Date().toISOString(),
    status: 'OPEN',
    released: false,
    releaseHistory: [],
    provenance: {
      fundingDecision: fundingResult?.final_decision || null,
      preliminaryDecision: fundingResult?.preliminary_decision || null,
      hypothesis: summarizeHypothesis(hypothesis)
    },
    investors: new Map(),
    contributions: []
  };

  updateCampaignStatus(campaign);
  fundingState.campaigns.set(campaign.id, campaign);
  markDatabaseDirty();
  return campaign;
}

function upsertInvestorProfile(profile) {
  const accountId = String(profile.accountId || '').trim();
  if (!accountId) {
    throw new Error('accountId is required');
  }

  const investor = {
    accountId,
    displayName: String(profile.displayName || accountId),
    alias: profile.alias ? String(profile.alias) : null,
    riskAppetite: String(profile.riskAppetite || 'balanced').toLowerCase(),
    thesis: profile.thesis ? String(profile.thesis) : '',
    preferredFields: Array.isArray(profile.preferredFields) ? profile.preferredFields.map(String) : [],
    walletProvider: profile.walletProvider ? String(profile.walletProvider) : null,
    holAlias: profile.holAlias ? String(profile.holAlias) : null,
    updatedAt: new Date().toISOString()
  };

  fundingState.investors.set(accountId, investor);
  markDatabaseDirty();
  return investor;
}

function scoreCampaignMatch(investor, campaign) {
  const riskMap = { conservative: 1, balanced: 2, aggressive: 3 };
  const campaignRiskMap = { low: 1, medium: 2, high: 3 };
  const investorRisk = riskMap[investor.riskAppetite] || 2;
  const campaignRisk = campaignRiskMap[campaign.riskLevel] || 2;
  const riskAlignment = Math.max(0, 1 - (Math.abs(investorRisk - campaignRisk) / 3));
  const impactFactor = campaign.impactScore ? Math.min(1, campaign.impactScore / 10) : 0.5;
  const fieldFactor = investor.preferredFields.length
    ? 0.7
    : 0.5;

  return Number(((riskAlignment * 0.5) + (impactFactor * 0.35) + (fieldFactor * 0.15)).toFixed(3));
}

function createContributionIntent({ campaign, investor, amountUsd, amountTinybar }) {
  const cfg = getFundingConfig();
  return {
    contributionId: makeContributionId(),
    campaignId: campaign.id,
    experimentId: campaign.experimentId,
    contributor: investor,
    asset: campaign.acceptedAsset,
    amountUsd,
    amountTinybar,
    amountHbar: fromTinybarToHbar(amountTinybar),
    treasuryAccountId: campaign.treasuryAccountId,
    mirrorNodeBaseUrl: cfg.mirrorNodeBaseUrl,
    paymentMemo: `ALCH-${campaign.id}-${investor.accountId}`,
    instructions: campaign.treasuryAccountId
      ? `Send ${fromTinybarToHbar(amountTinybar)} ${campaign.acceptedAsset} to treasury ${campaign.treasuryAccountId} and keep the transaction ID for verification.`
      : 'Treasury account is not configured yet. Set FUNDRAISING_TREASURY_ACCOUNT_ID or HEDERA_ACCOUNT_ID in .env.'
  };
}

async function verifyMirrorNodeContribution({ transactionId, contributorAccountId, campaign, minTinybar }) {
  const cfg = getFundingConfig();
  const response = await fetch(`${cfg.mirrorNodeBaseUrl}/transactions/${encodeURIComponent(transactionId)}`);
  if (!response.ok) {
    throw new Error(`Mirror node lookup failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const tx = payload.transactions?.[0];
  if (!tx) {
    throw new Error('Transaction not found on mirror node');
  }

  const transfers = tx.transfers || [];
  const incoming = transfers.find((item) =>
    String(item.account) === String(campaign.treasuryAccountId) && Number(item.amount) >= minTinybar
  );
  const outgoing = transfers.find((item) =>
    String(item.account) === String(contributorAccountId) && Number(item.amount) <= -minTinybar
  );

  if (!incoming) {
    throw new Error('Mirror node transaction does not include the required treasury transfer');
  }
  if (!outgoing) {
    throw new Error('Mirror node transaction does not show the expected contributor debit');
  }

  return {
    transactionId,
    consensusTimestamp: tx.consensus_timestamp || null,
    treasuryAmountTinybar: Number(incoming.amount),
    contributorAmountTinybar: Math.abs(Number(outgoing.amount))
  };
}

async function recordContribution({
  campaignId,
  contributorAccountId,
  amountUsd,
  amountTinybar,
  transactionId = null,
  verification = 'manual',
  investorProfile = null
}) {
  const campaign = fundingState.campaigns.get(campaignId);
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (!contributorAccountId) {
    throw new Error('contributorAccountId is required');
  }

  const contribution = {
    id: makeContributionId(),
    campaignId,
    experimentId: campaign.experimentId,
    contributorAccountId: String(contributorAccountId),
    amountUsd: Number(amountUsd.toFixed(2)),
    amountTinybar,
    amountHbar: fromTinybarToHbar(amountTinybar),
    transactionId,
    verification,
    verifiedAt: verification === 'mirror-node' ? new Date().toISOString() : null,
    createdAt: new Date().toISOString()
  };

  fundingState.contributions.unshift(contribution);
  campaign.contributions.unshift(contribution);
  campaign.raisedUsd = Number((campaign.raisedUsd + contribution.amountUsd).toFixed(2));
  campaign.raisedTinybar += amountTinybar;
  campaign.investors.set(contributorAccountId, investorProfile || fundingState.investors.get(contributorAccountId) || {
    accountId: contributorAccountId,
    displayName: contributorAccountId,
    riskAppetite: 'balanced',
    updatedAt: new Date().toISOString()
  });

  updateCampaignStatus(campaign);
  markDatabaseDirty();
  return contribution;
}

function normalizeReviewerReview(raw, reviewer) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const score = Math.max(1, Math.min(10, Number(safe.score) || 0));
  return {
    reviewer_id: reviewer.identity,
    reviewer_title: reviewer.title,
    focus: reviewer.focus,
    score,
    issues: Array.isArray(safe.issues) ? safe.issues.map(String).slice(0, 5) : [],
    strengths: Array.isArray(safe.strengths) ? safe.strengths.map(String).slice(0, 5) : [],
    verdict: String(safe.verdict || 'REVISE').toUpperCase(),
    evidence_summary: String(safe.evidence_summary || 'No evidence summary provided.'),
    confidence: ['low', 'medium', 'high'].includes(String(safe.confidence || '').toLowerCase())
      ? String(safe.confidence).toLowerCase()
      : 'medium'
  };
}

function aggregatePeerReviews(reviews) {
  const normalized = {};
  for (const review of reviews) {
    normalized[review.dimension] = {
      score: review.score,
      issues: review.issues,
      strengths: review.strengths,
      verdict: review.verdict,
      evidence_summary: review.evidence_summary,
      confidence: review.confidence,
      reviewer_id: review.reviewer_id
    };
  }

  const validityScore = normalized.validity?.score || 0;
  const testabilityScore = normalized.testability?.score || 0;
  const minScore = Math.min(...reviews.map((review) => review.score));
  const avgScore = reviews.reduce((sum, review) => sum + review.score, 0) / Math.max(reviews.length, 1);
  const verdicts = reviews.map((review) => review.verdict);
  const rejectCount = verdicts.filter((verdict) => verdict === 'REJECT').length;
  const reviseCount = verdicts.filter((verdict) => verdict === 'REVISE').length;

  let finalDecision = 'ACCEPT';
  if (validityScore < 5 || testabilityScore < 5 || rejectCount >= 2 || minScore <= 3) {
    finalDecision = 'REJECT';
  } else if (validityScore < 7 || testabilityScore < 7 || reviseCount >= 2 || avgScore < 7) {
    finalDecision = 'REVISE';
  }

  const confidence =
    avgScore >= 8 ? 'high' :
    avgScore >= 6 ? 'medium' :
    'low';

  const reasoning = reviews.map((review) => {
    const topIssue = review.issues[0] || 'no major issue identified';
    const topStrength = review.strengths[0] || 'no clear strength identified';
    return `${review.reviewer_title}: score ${review.score}/10, verdict ${review.verdict}, strength ${topStrength}, issue ${topIssue}.`;
  }).join(' ');

  return {
    reviews: normalized,
    final_decision: finalDecision,
    confidence,
    aggregated_reasoning: reasoning
  };
}

async function maybeReviseHypothesis(hypothesis, aggregatedReview) {
  if (aggregatedReview.final_decision !== 'REVISE') {
    return null;
  }

  const systemPrompt = [
    'You revise scientific hypotheses based on peer review.',
    'Return ONLY valid JSON for the revised hypothesis.',
    'Preserve the original structure and make it more testable, concrete, and feasible.'
  ].join('\n');

  const userMessage = [
    'Original hypothesis:',
    JSON.stringify(hypothesis, null, 2),
    '',
    'Peer review summary:',
    JSON.stringify(aggregatedReview, null, 2),
    '',
    'Return JSON with the same fields as the original hypothesis.'
  ].join('\n');

  try {
    const result = await runAgentModelChain({
      agentKey: 'peerReviewRevision',
      systemPrompt,
      userMessage,
      maxTokens: 1200
    });
    return tryParseModelJson(result.raw);
  } catch (err) {
    return null;
  }
}

async function recordPeerReviewProvenance(experimentId, hypothesis, reviews, aggregatedReview, researchContext) {
  const entries = reviews.map((review) => ({
    message_id: `msg-peer-${review.dimension}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: review.reviewer_id,
    agent_type: 'PEER_REVIEW',
    action_type: 'REVIEWER_PROVENANCE',
    experiment_id: experimentId || `exp-peer-${Date.now()}`,
    payload: {
      dimension: review.dimension,
      reviewer_title: review.reviewer_title,
      focus: review.focus,
      score: review.score,
      verdict: review.verdict,
      confidence: review.confidence,
      evidence_summary: review.evidence_summary,
      topic_query: researchContext.query,
      papers_used: researchContext.papers.map((paper) => ({
        paperId: paper.paperId,
        title: paper.title,
        year: paper.year,
        relevanceScore: paper.relevanceScore,
        url: paper.url
      })),
      hypothesis: summarizeHypothesis(hypothesis)
    }
  }));

  entries.push({
    message_id: `msg-peer-aggregate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: 'peer-review-aggregator-001',
    agent_type: 'PEER_REVIEW',
    action_type: 'REVIEW_AGGREGATED',
    experiment_id: experimentId || `exp-peer-${Date.now()}`,
    payload: {
      final_decision: aggregatedReview.final_decision,
      confidence: aggregatedReview.confidence,
      reasoning: aggregatedReview.aggregated_reasoning
    }
  });

  const provenance = [];
  for (const entry of entries) {
    try {
      const [hcsResult, htsResult] = await Promise.all([
        submitMessageToHCS(entry),
        syncHTSForEntry(entry)
      ]);
      entry.hedera = { hcs: hcsResult, hts: htsResult };
    } catch (err) {
      entry.hedera = {
        error: err.message,
        hcs: { mode: 'simulated', submitted: false },
        hts: { mode: 'simulated', executed: false }
      };
    }

    hcsLog.unshift({
      ...entry,
      timestamp: new Date().toISOString(),
      id: `hcs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    });
    if (hcsLog.length > 100) {
      hcsLog.pop();
    }

    provenance.push({
      reviewer_id: entry.agent_id,
      action_type: entry.action_type,
      hedera: entry.hedera
    });
  }

  return provenance;
}

async function runPeerReviewPipeline({ hypothesis, experimentId }) {
  const researchContext = await buildPeerReviewResearchContext(hypothesis);

  const reviewerRuns = await Promise.all(PEER_REVIEWERS.map(async (reviewer) => {
    const systemPrompt = [
      `You are ${reviewer.title} in the ALCHEMY Protocol peer-review council.`,
      `Your sole responsibility is ${reviewer.focus}.`,
      'Use the supplied literature evidence and respond only in strict JSON.',
      'Do not perform aggregation or discuss dimensions outside your assignment.'
    ].join('\n');

    const userMessage = buildPeerReviewReviewerPrompt(reviewer, hypothesis, researchContext);
    const result = await runAgentModelChain({
      agentKey: `peerReview:${reviewer.key}`,
      systemPrompt,
      userMessage,
      maxTokens: 1000
    });
    const parsed = tryParseModelJson(result.raw);
    const review = normalizeReviewerReview(parsed, reviewer);
    return {
      dimension: reviewer.key,
      ...review,
      provider: result.provider,
      model: result.model,
      fallbackReason: result.fallbackReason || null
    };
  }));

  const aggregatedReview = aggregatePeerReviews(reviewerRuns);
  const revisedHypothesis = await maybeReviseHypothesis(hypothesis, aggregatedReview);
  const provenance = await recordPeerReviewProvenance(
    experimentId,
    hypothesis,
    reviewerRuns,
    aggregatedReview,
    researchContext
  );

  return {
    ...aggregatedReview,
    revised_hypothesis: revisedHypothesis,
    reviewer_runs: reviewerRuns,
    provenance,
    retrieval: researchContext
  };
}


async function buildAgentExecutionPayload(body) {
  const {
    agentKey,
    systemPrompt,
    userMessage,
    maxTokens = 4096,
    topic,
    hypothesis,
    experimentId,
    laborResult,
    resultsData
  } = body;

  let finalUserMessage = userMessage;
  let retrieval = null;

  if (agentKey === 'hypothesis') {
    if (!topic) {
      throw new Error('Hypothesis agent requires a topic');
    }

    retrieval = await buildHypothesisResearchContext(topic);
    finalUserMessage = buildHypothesisUserMessage(topic, userMessage, retrieval);
  }

  if (agentKey === 'peerReview') {
    const targetHypothesis = hypothesis || tryParseModelJson(userMessage) || userMessage;
    const peerReviewResult = await runPeerReviewPipeline({
      hypothesis: targetHypothesis,
      experimentId
    });

    return {
      raw: JSON.stringify(peerReviewResult, null, 2),
      parsed: peerReviewResult,
      usage: null,
      provider: 'multi-reviewer-chain',
      model: 'mistral/ollama-per-reviewer',
      fallbackReason: peerReviewResult.reviewer_runs.some((run) => run.fallbackReason) ? 'One or more reviewer calls used Ollama fallback' : null,
      retrieval: peerReviewResult.retrieval
    };
  }

  if (agentKey === 'results') {
    return buildResultsExecutionPayload({
      hypothesis,
      experimentId,
      laborResult,
      systemPrompt,
      userMessage,
      maxTokens
    });
  }

  if (agentKey === 'replication') {
    return buildReplicationExecutionPayload({
      hypothesis,
      experimentId,
      resultsData,
      systemPrompt,
      userMessage,
      maxTokens
    });
  }

  const result = await runAgentModelChain({
    agentKey,
    systemPrompt,
    userMessage: finalUserMessage,
    maxTokens
  });

  return {
    raw: result.raw,
    parsed: tryParseModelJson(result.raw),
    usage: result.usage || null,
    provider: result.provider,
    model: result.model,
    fallbackReason: result.fallbackReason || null,
    retrieval
  };
}


registerFundingRoutes({
  app,
  fundingState,
  getFundraisingStatus,
  serializeCampaign,
  createCampaignFromFundingResult,
  upsertInvestorProfile,
  scoreCampaignMatch,
  parseCurrencyAmount,
  getFundingConfig,
  toTinybarFromUsd,
  createContributionIntent,
  verifyMirrorNodeContribution,
  recordContribution,
  submitMessageToHCS,
  updateCampaignStatus,
  fromTinybarToHbar
});

registerResultsRoutes({
  app,
  resultsState,
  getResultsStatus,
  replicationState,
  getReplicationStatus,
  serializeReplicationMarketplace,
  createReplicationMarketplace,
  logLaborEvent,
  serializeReplicationTask,
  upsertReplicationWorker
});

registerLaborRoutes({
  app,
  laborState,
  getLaborStatus,
  serializeMarketplace,
  createLaborMarketplace,
  logLaborEvent,
  serializeTask,
  upsertWorkerProfile,
  getLaborConfig,
  parseTokenAmount,
  transferExpToWorker
});

app.get('/api/health', async (req, res) => {
  let ollama = 'unknown';
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    ollama = response.ok ? 'reachable' : 'unreachable';
  } catch (err) {
    ollama = 'unreachable';
  }

  res.json({
    status: 'ok',
    hedera_account: hasConfiguredValue(process.env.HEDERA_ACCOUNT_ID, ['0.0.XXXXXXX']) ? process.env.HEDERA_ACCOUNT_ID : 'not-configured',
    hol_api: hasConfiguredValue(process.env.REGISTRY_BROKER_API_KEY, ['rbk_...']) ? 'configured' : 'not-configured',
    mistral: hasConfiguredValue(MISTRAL_API_KEY, ['your_mistral_api_key_here']) ? 'configured' : 'MISSING - add to .env',
    hedera: getHederaMode(),
    fundraising: getFundraisingStatus(),
    labor: getLaborStatus(),
    results: getResultsStatus(),
    replication: getReplicationStatus(),
    agent: {
      autoRegister: getAgentEnvConfig().autoRegister,
      registrationStatus: agentRuntime.registration?.status || 'unregistered'
    },
    database: getDatabaseStatus(),
    inference: {
      ...getInferenceStatus(),
      ollama
    }
  });
});

app.get('/.well-known/ai-agent.json', (req, res) => {
  const card = createAgentCard(getPublicBaseUrl(req));
  agentRuntime.agentCard = card;
  res.json(card);
});

app.get('/api/agent/card', (req, res) => {
  const card = createAgentCard(getPublicBaseUrl(req));
  agentRuntime.agentCard = card;
  res.json(card);
});

app.post('/api/hol/register', async (req, res) => {
  try {
    const registration = await ensureHolAgentRegistration(getPublicBaseUrl(req));
    res.json({
      success: true,
      registration,
      card: createAgentCard(getPublicBaseUrl(req))
    });
  } catch (err) {
    agentRuntime.lastRegistrationError = err.message;
    appendRegistrationProgress({ stage: 'failed', message: err.message });
    res.status(500).json({ success: false, error: err.message, card: createAgentCard(getPublicBaseUrl(req)) });
  }
});

app.get('/api/hol/status', (req, res) => {
  res.json({
    registration: agentRuntime.registration,
    error: agentRuntime.lastRegistrationError,
    progress: agentRuntime.registrationProgress,
    card: createAgentCard(getPublicBaseUrl(req))
  });
});

app.get('/api/research/health', async (req, res) => {
  try {
    const papers = await fetchSemanticScholarPapers(req.query.topic || 'transformer interpretability', 3);
    const reranked = await rerankPapersWithBge(req.query.topic || 'transformer interpretability', papers);
    res.json({
      status: 'ok',
      semanticScholar: 'reachable',
      bgeModel: reranked.model,
      sampleCount: reranked.papers.length
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

app.post('/api/research/papers', async (req, res) => {
  const { topic } = req.body;
  if (!topic) {
    return res.status(400).json({ error: 'topic is required' });
  }

  try {
    const context = await buildHypothesisResearchContext(topic);
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent', async (req, res) => {
  try {
    const result = await buildAgentExecutionPayload(req.body);
    res.json(result);
  } catch (err) {
    console.error('Agent error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const transcript = Array.isArray(history)
      ? history.slice(-8).map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`).join('\n')
      : '';

    const result = await runAgentModelChain({
      agentKey: 'chat',
      systemPrompt: buildChatSystemPrompt(),
      userMessage: transcript ? `${transcript}\nUser: ${message}` : String(message),
      maxTokens: 1200
    });

    const reply = result.raw || 'I was not able to generate a reply.';
    agentRuntime.chatHistory.push(
      { role: 'user', content: String(message), timestamp: new Date().toISOString() },
      { role: 'assistant', content: reply, timestamp: new Date().toISOString(), provider: result.provider, model: result.model }
    );
    if (agentRuntime.chatHistory.length > 40) {
      agentRuntime.chatHistory.splice(0, agentRuntime.chatHistory.length - 40);
    }
    markDatabaseDirty();

    res.json({
      reply,
      provider: result.provider,
      model: result.model,
      fallbackReason: result.fallbackReason || null,
      history: agentRuntime.chatHistory.slice(-12)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chat/history', (req, res) => {
  res.json(agentRuntime.chatHistory.slice(-20));
});

app.get('/mcp/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const card = createAgentCard(getPublicBaseUrl(req));
  res.write(`event: agent-card\n`);
  res.write(`data: ${JSON.stringify(card)}\n\n`);
  res.write(`event: status\n`);
  res.write(`data: ${JSON.stringify({ message: 'ALCHEMY MCP bridge is online', registration: agentRuntime.registration?.status || 'unregistered' })}\n\n`);
  req.on('close', () => {
    res.end();
  });
});

app.post('/api/hcs/log', async (req, res) => {
  const entry = {
    ...req.body,
    timestamp: new Date().toISOString(),
    id: `hcs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };

  try {
    const [hcsResult, htsResult] = await Promise.all([
      submitMessageToHCS(entry),
      syncHTSForEntry(entry)
    ]);
    entry.hedera = { hcs: hcsResult, hts: htsResult };
  } catch (err) {
    entry.hedera = {
      error: err.message,
      hcs: { mode: 'simulated', submitted: false },
      hts: { mode: 'simulated', executed: false }
    };
  }

  hcsLog.unshift(entry);
  if (hcsLog.length > 100) {
    hcsLog.pop();
  }
  markDatabaseDirty();

  res.json({ status: 'logged', entry });
});

app.get('/api/hcs/log', (req, res) => {
  res.json(hcsLog.slice(0, 50));
});

app.delete('/api/hcs/log', (req, res) => {
  hcsLog.length = 0;
  markDatabaseDirty();
  res.json({ status: 'cleared' });
});

app.post('/api/hol/update', (req, res) => {
  const { agent_id, reputation_score, trust_level, contributions, owned_experiments } = req.body;
  holRegistry[agent_id] = {
    agent_id,
    reputation_score,
    trust_level,
    contributions: contributions || [],
    owned_experiments: owned_experiments || [],
    last_updated: new Date().toISOString()
  };
  markDatabaseDirty();
  res.json({ status: 'updated', registry: holRegistry[agent_id] });
});

app.get('/api/hol/registry', (req, res) => {
  res.json(holRegistry);
});

app.delete('/api/hol/registry', (req, res) => {
  Object.keys(holRegistry).forEach((key) => delete holRegistry[key]);
  markDatabaseDirty();
  res.json({ status: 'cleared' });
});

app.get('/api/hts/status', (req, res) => {
  res.json({
    hedera: getHederaMode(),
    tokens: {
      exp_token_id: hederaState.expTokenId,
      publication_token_id: hederaState.publicationTokenId
    }
  });
});

const PORT = process.env.PORT || 3000;
loadResultsState()
  .then(() => initializeDatabase({
    projectRoot,
    hederaState,
    hcsLog,
    holRegistry,
    agentRuntime,
    fundingState,
    laborState,
    resultsState,
    replicationState
  }))
  .then(() => {
    startDatabaseAutosave();
    app.listen(PORT, () => {
    const hedera = getHederaMode();
    const agentCfg = getAgentEnvConfig();
    console.log(`\nALCHEMY Protocol Server running at http://localhost:${PORT}`);
    console.log(`Mistral API: ${hasConfiguredValue(MISTRAL_API_KEY, ['your_mistral_api_key_here']) ? `configured (model: ${MODEL})` : 'missing - add MISTRAL_API_KEY to .env'}`);
    console.log(`Ollama Fallback: ${OLLAMA_BASE_URL} (model ${OLLAMA_MODEL})`);
    console.log(`BGE Reranker: ${BGE_MODEL}`);
    console.log(`Hedera Account: ${hasConfiguredValue(process.env.HEDERA_ACCOUNT_ID, ['0.0.XXXXXXX']) ? process.env.HEDERA_ACCOUNT_ID : 'not configured (simulated)'}`);
    console.log(`HCS: ${hedera.hcs.toUpperCase()} ${process.env.HCS_TOPIC_ID ? `(topic ${process.env.HCS_TOPIC_ID})` : '(set HCS_TOPIC_ID)'}`);
    console.log(`HTS: ${hedera.hts.toUpperCase()} ${hederaState.expTokenId ? `(EXP ${hederaState.expTokenId})` : '(auto-create or set HTS_EXP_TOKEN_ID)'}`);
    console.log(`Publication NFT: ${hederaState.publicationTokenId || 'auto-create when HTS enabled'}`);
    console.log(`HOL Registry: ${hasConfiguredValue(process.env.REGISTRY_BROKER_API_KEY, ['rbk_...']) ? 'configured' : 'not configured (simulated)'}`);
    console.log(`Database: SQLite (${getDatabaseStatus().enabled ? 'enabled' : 'not ready'})`);
    console.log(`Agent Discovery: http://localhost:${PORT}/.well-known/ai-agent.json`);
    console.log(`Natural Language Chat: http://localhost:${PORT}/api/chat`);
    console.log(`MCP SSE Bridge: http://localhost:${PORT}/mcp/sse\n`);

    if (agentCfg.autoRegister) {
      ensureHolAgentRegistration(agentCfg.publicAppUrl || `http://localhost:${PORT}`)
        .then(() => {
          console.log('HOL agent auto-registration completed');
        })
        .catch((err) => {
          agentRuntime.lastRegistrationError = err.message;
          console.error('HOL agent auto-registration failed:', err.message);
        });
    }
    });
  })
  .catch((err) => {
    console.error('Server startup failed:', err.message);
    process.exitCode = 1;
  });

process.on('SIGINT', () => {
  shutdownDatabase()
    .finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdownDatabase()
    .finally(() => process.exit(0));
});
