const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  projectRoot,
  laborState,
  resultsState,
  replicationState,
  hasConfiguredValue,
  loadHederaSdk,
  getHederaMode,
  getLaborConfig,
  persistResultsState,
  parseTokenAmount,
  parseMetricValue,
  safeJsonParse,
  makeReplicationMarketplaceId,
  makeReplicationTaskId
} = require('../core/runtime');
const { summarizeHypothesis } = require('../agents/research');
const { markDatabaseDirty } = require('../db/sqlite');

async function buildArtifactDescriptor(reference) {
  const raw = String(reference || '').trim();
  if (!raw) {
    return null;
  }

  const descriptor = {
    reference: raw,
    kind: /^https?:\/\//i.test(raw) ? 'url' : 'inline',
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw, 'utf8'),
    accessible: false,
    parsed: null
  };

  const localPath = path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
  try {
    const stat = await fs.promises.stat(localPath);
    if (stat.isFile()) {
      const content = await fs.promises.readFile(localPath);
      descriptor.kind = 'file';
      descriptor.accessible = true;
      descriptor.bytes = content.length;
      descriptor.sha256 = crypto.createHash('sha256').update(content).digest('hex');
      descriptor.path = localPath;
      const parsed = safeJsonParse(content.toString('utf8'));
      if (parsed) {
        descriptor.parsed = parsed;
      }
    }
  } catch {
    // Keep non-local references as unresolved but still hashable.
  }

  return descriptor;
}

function serializeReplicationTask(task) {
  return {
    ...task,
    claims: task.claims.slice(-10),
    submissions: task.submissions.slice(-10)
  };
}

function serializeReplicationMarketplace(marketplace) {
  return {
    ...marketplace,
    tasks: marketplace.taskIds.map((taskId) => serializeReplicationTask(replicationState.tasks.get(taskId))).filter(Boolean)
  };
}

async function aggregateLaborArtifacts(experimentId) {
  const tasks = Array.from(laborState.tasks.values()).filter((task) => task.experimentId === experimentId);
  const approvedTasks = tasks.filter((task) => task.verification?.verdict === 'APPROVED');
  const taskEntries = [];

  for (const task of approvedTasks) {
    const submission = task.submissions[0] || null;
    const artifactRefs = Array.isArray(submission?.artifacts) ? submission.artifacts : [];
    const artifactDescriptors = (await Promise.all(artifactRefs.map(buildArtifactDescriptor))).filter(Boolean);
    taskEntries.push({
      taskId: task.id,
      description: task.description,
      workerAccountId: task.assignedWorkerAccountId,
      resultSummary: submission?.resultSummary || '',
      proof: submission?.proof || '',
      artifacts: artifactDescriptors,
      verification: task.verification,
      payout: task.payout
    });
  }

  return {
    totalTasks: tasks.length,
    approvedTasks: approvedTasks.length,
    taskEntries
  };
}

function computeMetricsFromArtifacts(artifactAggregation) {
  const metrics = {
    accuracy: null,
    loss: null,
    improvement: null
  };
  const findings = [];

  for (const task of artifactAggregation.taskEntries) {
    for (const artifact of task.artifacts) {
      const parsed = artifact.parsed;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      if (metrics.accuracy == null && parsed.accuracy != null) {
        metrics.accuracy = parsed.accuracy;
        findings.push(`accuracy derived from ${artifact.reference}`);
      }
      if (metrics.loss == null && parsed.loss != null) {
        metrics.loss = parsed.loss;
        findings.push(`loss derived from ${artifact.reference}`);
      }
      if (metrics.improvement == null && parsed.improvement != null) {
        metrics.improvement = parsed.improvement;
        findings.push(`improvement derived from ${artifact.reference}`);
      }
    }
  }

  return {
    metrics,
    findings
  };
}

function buildPublicationBundle({ experimentId, hypothesis, artifactAggregation, resultPayload }) {
  const manifest = {
    experimentId,
    generatedAt: new Date().toISOString(),
    hypothesis: summarizeHypothesis(hypothesis),
    tasks: artifactAggregation.taskEntries.map((entry) => ({
      taskId: entry.taskId,
      workerAccountId: entry.workerAccountId,
      resultSummary: entry.resultSummary,
      verification: entry.verification,
      payout: entry.payout,
      artifacts: entry.artifacts.map((artifact) => ({
        reference: artifact.reference,
        kind: artifact.kind,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        accessible: artifact.accessible
      }))
    })),
    resultSummary: {
      finalStatus: resultPayload.final_status,
      validation: resultPayload.validation,
      metrics: resultPayload.metrics,
      consistency: resultPayload.consistency,
      anomalies: resultPayload.anomalies
    }
  };

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestHash = crypto.createHash('sha256').update(manifestJson).digest('hex');
  return {
    manifest,
    manifestJson,
    manifestHash
  };
}

function signPublicationBundle(manifestJson) {
  const sdk = loadHederaSdk();
  if (!sdk || !hasConfiguredValue(process.env.HEDERA_PRIVATE_KEY, ['302e...'])) {
    return {
      algorithm: 'sha256',
      signature: null,
      signer: 'not-configured'
    };
  }

  try {
    const privateKey = sdk.PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY);
    const signature = Buffer.from(privateKey.sign(Buffer.from(manifestJson, 'utf8'))).toString('hex');
    return {
      algorithm: 'ed25519',
      signature,
      signer: process.env.HEDERA_ACCOUNT_ID || 'configured-operator'
    };
  } catch {
    return {
      algorithm: 'sha256',
      signature: null,
      signer: 'signature-failed'
    };
  }
}

async function finalizeResultsPayouts(resultPayload, transferExpToWorker) {
  const rewards = Array.isArray(resultPayload?.rewards) ? resultPayload.rewards : [];
  const payouts = [];

  for (const reward of rewards) {
    const contributor = String(reward.contributor || '').trim();
    if (!contributor) {
      continue;
    }

    const amount = parseTokenAmount(reward.tokens_awarded, 0);
    if (amount <= 0) {
      continue;
    }

    const payout = await transferExpToWorker(contributor, amount);
    payouts.push({
      contributor,
      amount,
      justification: reward.justification || '',
      payout
    });
  }

  return payouts;
}

function upsertReplicationWorker(profile) {
  const accountId = String(profile.accountId || '').trim();
  if (!accountId) {
    throw new Error('accountId is required');
  }

  const worker = {
    accountId,
    displayName: String(profile.displayName || accountId),
    alias: profile.alias ? String(profile.alias) : null,
    workerType: String(profile.workerType || 'replication').toLowerCase(),
    skills: Array.isArray(profile.skills) ? profile.skills.map(String) : [],
    walletProvider: profile.walletProvider ? String(profile.walletProvider) : null,
    updatedAt: new Date().toISOString()
  };

  replicationState.workers.set(accountId, worker);
  markDatabaseDirty();
  return worker;
}

function createReplicationMarketplace({ experimentId, resultsData }) {
  const registryRecord = resultsState.registry.get(experimentId);
  const manifestHash = resultsData?.publication_bundle?.manifest_hash || registryRecord?.manifestHash || null;
  const marketplace = {
    id: makeReplicationMarketplaceId(),
    experimentId,
    manifestHash,
    createdAt: new Date().toISOString(),
    taskIds: []
  };

  const task = {
    id: makeReplicationTaskId(),
    marketplaceId: marketplace.id,
    experimentId,
    manifestHash,
    description: 'Re-run the published experiment bundle and verify reproducibility against the stored manifest.',
    status: 'OPEN',
    assignedWorkerAccountId: null,
    reward: 75,
    token: `${getLaborConfig().payoutAsset}_TOKEN`,
    claims: [],
    submissions: [],
    verification: null,
    payout: null
  };

  replicationState.tasks.set(task.id, task);
  marketplace.taskIds.push(task.id);
  replicationState.marketplaces.set(marketplace.id, marketplace);
  markDatabaseDirty();
  return marketplace;
}

function collectReplicationArtifacts(submission) {
  const artifactRefs = Array.isArray(submission?.artifacts) ? submission.artifacts : [];
  return Promise.all(artifactRefs.map(buildArtifactDescriptor));
}

function computeDeviation(originalMetric, replicatedMetric) {
  if (originalMetric == null || replicatedMetric == null) {
    return null;
  }
  if (originalMetric === 0) {
    return Number(Math.abs(replicatedMetric).toFixed(6));
  }
  return Number((Math.abs(originalMetric - replicatedMetric) / Math.abs(originalMetric) * 100).toFixed(4));
}

function classifyDeviation(deviation) {
  if (deviation == null) {
    return 'UNKNOWN';
  }
  if (deviation <= 2) {
    return 'STRONG';
  }
  if (deviation <= 5) {
    return 'ACCEPTABLE';
  }
  return 'WEAK';
}

function deriveTrustFromDeviation(deviation) {
  if (deviation == null) {
    return { level: 'MEDIUM', confidence: '0.50' };
  }
  if (deviation <= 2) {
    return { level: 'HIGH', confidence: '0.92' };
  }
  if (deviation <= 5) {
    return { level: 'MEDIUM', confidence: '0.68' };
  }
  return { level: 'LOW', confidence: '0.28' };
}

async function updatePublicationNftReputationOnChain(resultsData, replicationSummary, createHederaClient) {
  const sdk = loadHederaSdk();
  const mode = getHederaMode();
  const tokenId = resultsData?.hedera_record?.nft_token_id || resultsData?.registry_record?.nft_token_id || null;
  const serials = resultsData?.hedera_record?.nft_serials || resultsData?.registry_record?.nft_serials || [];
  if (!sdk || mode.hts !== 'enabled') {
    return { mode: 'simulated', updated: false, reason: 'HTS not fully configured' };
  }
  if (!tokenId || !Array.isArray(serials) || !serials.length) {
    return { mode: 'simulated', updated: false, reason: 'NFT token id or serials not available for reputation update' };
  }

  const { client, privateKey } = createHederaClient(sdk);
  try {
    const metadata = Buffer.from(JSON.stringify({
      trust: replicationSummary.trust.level,
      confidence: replicationSummary.trust.confidence,
      verdict: replicationSummary.final_verdict,
      updatedAt: new Date().toISOString()
    }).slice(0, 100), 'utf8');

    const updateTx = await new sdk.TokenUpdateNftsTransaction()
      .setTokenId(tokenId)
      .setSerialNumbers(serials.map((serial) => Number(serial)))
      .setMetadata(metadata)
      .freezeWith(client)
      .sign(privateKey);
    const submit = await updateTx.execute(client);
    const receipt = await submit.getReceipt(client);
    return {
      mode: 'hedera',
      updated: true,
      transaction_id: submit.transactionId.toString(),
      status: receipt.status.toString()
    };
  } catch (err) {
    return {
      mode: 'simulated',
      updated: false,
      reason: err.message
    };
  } finally {
    client.close();
  }
}

function createResultsWorkflow({
  runAgentModelChain,
  tryParseModelJson,
  transferExpToWorker,
  createHederaClient
}) {
  return {
    serializeReplicationTask,
    serializeReplicationMarketplace,
    upsertReplicationWorker,
    createReplicationMarketplace,
    async buildReplicationExecutionPayload({ hypothesis, experimentId, resultsData, systemPrompt, userMessage, maxTokens }) {
      const registryRecord = resultsState.registry.get(experimentId);
      if (!registryRecord) {
        throw new Error(`No publication registry record found for experiment ${experimentId}`);
      }

      const originalMetrics = {
        accuracy: parseMetricValue(resultsData?.metrics?.accuracy),
        loss: parseMetricValue(resultsData?.metrics?.loss),
        improvement: parseMetricValue(resultsData?.metrics?.improvement)
      };

      const manifest = registryRecord.manifest || {};
      const replicationTasks = Array.from(replicationState.tasks.values())
        .filter((task) => task.experimentId === experimentId && task.verification?.verdict === 'APPROVED');

      const recomputedMetrics = { ...originalMetrics };
      let evidenceSource = 'publication-bundle';

      if (replicationTasks.length > 0) {
        evidenceSource = 'replication-marketplace';
        for (const task of replicationTasks) {
          const submission = task.submissions[0];
          const descriptors = (await collectReplicationArtifacts(submission)).filter(Boolean);
          for (const descriptor of descriptors) {
            const parsed = descriptor.parsed;
            if (parsed && typeof parsed === 'object') {
              recomputedMetrics.accuracy = recomputedMetrics.accuracy ?? parseMetricValue(parsed.accuracy);
              recomputedMetrics.loss = recomputedMetrics.loss ?? parseMetricValue(parsed.loss);
              recomputedMetrics.improvement = recomputedMetrics.improvement ?? parseMetricValue(parsed.improvement);
            }
          }
        }
      }

      const accuracyDeviation = computeDeviation(originalMetrics.accuracy, recomputedMetrics.accuracy);
      const lossDeviation = computeDeviation(originalMetrics.loss, recomputedMetrics.loss);
      const improvementDeviation = computeDeviation(originalMetrics.improvement, recomputedMetrics.improvement);
      const deviations = [accuracyDeviation, lossDeviation, improvementDeviation].filter((value) => value != null);
      const overallDeviation = deviations.length
        ? Number((deviations.reduce((sum, value) => sum + value, 0) / deviations.length).toFixed(4))
        : null;
      const category = classifyDeviation(overallDeviation);
      const trust = deriveTrustFromDeviation(overallDeviation);

      const enrichedPrompt = [
        userMessage,
        '',
        'Publication bundle manifest:',
        JSON.stringify(manifest, null, 2),
        '',
        'Deterministically recomputed replication summary:',
        JSON.stringify({
          evidenceSource,
          originalMetrics,
          recomputedMetrics,
          overallDeviation,
          category,
          trust
        }, null, 2),
        '',
        'Use this real rerun evidence as the primary basis for the final replication JSON.'
      ].join('\n');

      const result = await runAgentModelChain({
        agentKey: 'replication',
        systemPrompt,
        userMessage: enrichedPrompt,
        maxTokens
      });

      const parsed = tryParseModelJson(result.raw) || {};
      parsed.reconstruction = parsed.reconstruction || { status: 'RECONSTRUCTED_FROM_PUBLICATION_BUNDLE', issues: [] };
      parsed.replication_results = parsed.replication_results || { metrics: {} };
      parsed.replication_results.metrics = {
        accuracy: parsed.replication_results.metrics?.accuracy ?? recomputedMetrics.accuracy,
        loss: parsed.replication_results.metrics?.loss ?? recomputedMetrics.loss,
        improvement: parsed.replication_results.metrics?.improvement ?? recomputedMetrics.improvement
      };
      parsed.comparison = {
        original: originalMetrics,
        replicated: parsed.replication_results.metrics,
        deviation: overallDeviation != null ? `${overallDeviation}%` : 'unavailable'
      };
      parsed.analysis = parsed.analysis || {};
      parsed.analysis.category = parsed.analysis.category || category;
      parsed.trust = parsed.trust || trust;
      parsed.trust.level = parsed.trust.level || trust.level;
      parsed.trust.confidence = parsed.trust.confidence || trust.confidence;
      parsed.hedera_log = parsed.hedera_log || { experiment_id: experimentId, record: {} };
      parsed.hedera_log.experiment_id = experimentId;
      parsed.hedera_log.record = {
        ...(parsed.hedera_log.record || {}),
        replicated_results: parsed.replication_results.metrics,
        deviation: parsed.comparison.deviation,
        trust_score: parsed.trust.level,
        nft_reputation_update: parsed.hedera_log.record?.nft_reputation_update || parsed.trust.level
      };
      parsed.final_verdict = parsed.final_verdict || (
        trust.level === 'HIGH' ? 'VERIFIED' :
        trust.level === 'MEDIUM' ? 'PARTIALLY_VERIFIED' :
        'NOT_VERIFIED'
      );

      const rewardAmount =
        trust.level === 'HIGH' ? 100 :
        trust.level === 'MEDIUM' ? 60 :
        20;
      parsed.reward = parsed.reward || {};
      parsed.reward.tokens_awarded = parsed.reward.tokens_awarded || String(rewardAmount);
      parsed.reward.justification = parsed.reward.justification || `Replication trust ${trust.level} from ${evidenceSource}`;

      const replicationPayouts = [];
      for (const task of replicationTasks) {
        if (task.assignedWorkerAccountId) {
          const payout = await transferExpToWorker(task.assignedWorkerAccountId, rewardAmount);
          task.payout = {
            amount: rewardAmount,
            asset: getLaborConfig().payoutAsset,
            workerAccountId: task.assignedWorkerAccountId,
            executedAt: new Date().toISOString(),
            ...payout
          };
          replicationPayouts.push(task.payout);
        }
      }

      const nftUpdate = await updatePublicationNftReputationOnChain(resultsData, parsed, createHederaClient);
      parsed.nft_reputation_update = nftUpdate;

      return {
        raw: JSON.stringify({
          ...parsed,
          rerun_source: evidenceSource,
          replication_payouts: replicationPayouts
        }, null, 2),
        parsed: {
          ...parsed,
          rerun_source: evidenceSource,
          replication_payouts: replicationPayouts
        },
        usage: result.usage || null,
        provider: result.provider,
        model: result.model,
        fallbackReason: result.fallbackReason || null,
        retrieval: {
          provider: 'publication-bundle',
          manifestHash: registryRecord.manifestHash,
          replicationTasks: replicationTasks.length
        }
      };
    },
    async buildResultsExecutionPayload({ hypothesis, experimentId, laborResult, systemPrompt, userMessage, maxTokens }) {
      const artifactAggregation = await aggregateLaborArtifacts(experimentId);
      const computed = computeMetricsFromArtifacts(artifactAggregation);
      const enrichedUserMessage = [
        userMessage,
        '',
        'Verified marketplace artifact summary:',
        JSON.stringify({
          totalTasks: artifactAggregation.totalTasks,
          approvedTasks: artifactAggregation.approvedTasks,
          tasks: artifactAggregation.taskEntries.map((entry) => ({
            taskId: entry.taskId,
            workerAccountId: entry.workerAccountId,
            resultSummary: entry.resultSummary,
            verification: entry.verification,
            artifacts: entry.artifacts.map((artifact) => ({
              reference: artifact.reference,
              kind: artifact.kind,
              sha256: artifact.sha256,
              accessible: artifact.accessible,
              parsed: artifact.parsed
            }))
          })),
          computedMetrics: computed.metrics,
          metricFindings: computed.findings
        }, null, 2),
        '',
        'Ground the final results in these verified task submissions. Prefer computed metrics from parsed artifact files when available.'
      ].join('\n');

      const result = await runAgentModelChain({
        agentKey: 'results',
        systemPrompt,
        userMessage: enrichedUserMessage,
        maxTokens
      });

      const parsed = tryParseModelJson(result.raw) || {};
      parsed.metrics = {
        accuracy: parsed.metrics?.accuracy ?? computed.metrics.accuracy,
        loss: parsed.metrics?.loss ?? computed.metrics.loss,
        improvement: parsed.metrics?.improvement ?? computed.metrics.improvement
      };

      const bundle = buildPublicationBundle({
        experimentId,
        hypothesis,
        artifactAggregation,
        resultPayload: parsed
      });
      const signature = signPublicationBundle(bundle.manifestJson);
      const payoutExecutions = await finalizeResultsPayouts(parsed, transferExpToWorker);

      const registryRecord = {
        experimentId,
        manifestHash: bundle.manifestHash,
        manifest: bundle.manifest,
        signature,
        computedMetrics: computed,
        payoutExecutions,
        publishedAt: new Date().toISOString()
      };

      resultsState.registry.set(experimentId, registryRecord);
      resultsState.bundles.set(bundle.manifestHash, {
        manifestJson: bundle.manifestJson,
        signature
      });
      markDatabaseDirty();
      await persistResultsState();

      parsed.publication_bundle = {
        manifest_hash: bundle.manifestHash,
        signature,
        task_count: artifactAggregation.totalTasks,
        approved_task_count: artifactAggregation.approvedTasks
      };
      parsed.registry_record = {
        experiment_id: experimentId,
        manifest_hash: bundle.manifestHash,
        published_at: registryRecord.publishedAt
      };
      parsed.reward_executions = payoutExecutions;

      return {
        raw: JSON.stringify(parsed, null, 2),
        parsed,
        usage: result.usage || null,
        provider: result.provider,
        model: result.model,
        fallbackReason: result.fallbackReason || null,
        retrieval: {
          provider: 'labor-marketplace',
          approvedTasks: artifactAggregation.approvedTasks,
          manifestHash: bundle.manifestHash
        }
      };
    }
  };
}

module.exports = {
  createResultsWorkflow,
  serializeReplicationTask,
  serializeReplicationMarketplace,
  upsertReplicationWorker,
  createReplicationMarketplace
};
