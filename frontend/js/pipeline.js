// ─── Pipeline Orchestration ────────────────────────────────────

function generateExperimentId() {
  return `EXP-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

// Subroutines for reputation scaling
function getRetrievalPenalty(result) {
  const retrieval = result?.retrieval || null;
  if (!retrieval) return 0.1;
  if (retrieval.degraded || retrieval.warning) return 0.25;
  if ((retrieval.totalFetched || 0) === 0) return 0.2;
  return 0;
}

function computeStageReputation(topic, stage, result, context = {}) {
  const topicQuality = assessTopicQuality(topic);
  const retrievalPenalty = getRetrievalPenalty(result);
  let score = 0.25 + (topicQuality.score * 0.35) - retrievalPenalty;

  if (stage === 'hypothesis') {
    const gaps = result?.parsed?.gaps?.length || 0;
    const hypotheses = result?.parsed?.hypotheses?.length || 0;
    score += Math.min(0.2, (gaps * 0.04) + (hypotheses * 0.04));
    if (!topicQuality.usable) score = Math.min(score, 0.38);
  }
  if (stage === 'peerReview') {
    const decision = result?.parsed?.final_decision;
    const confidence = String(result?.parsed?.confidence || '').toLowerCase();
    if (decision === 'ACCEPT') score += 0.18;
    if (decision === 'REVISE') score += 0.04;
    if (decision === 'REJECT') score -= 0.18;
    if (confidence === 'high') score += 0.08;
    if (confidence === 'low') score -= 0.08;
    if (!topicQuality.usable) score = Math.min(score, 0.45);
  }
  if (stage === 'fundraising') {
    const decision = result?.parsed?.final_decision;
    if (decision === 'APPROVED_FOR_EXECUTION') score += 0.12;
    if (decision === 'WAITING_FOR_MORE_FUNDS') score += 0.02;
    if (decision === 'REJECTED') score -= 0.14;
    if (!topicQuality.usable) score = Math.min(score, 0.42);
  }
  if (stage === 'labor') {
    const tasks = result?.parsed?.tasks?.length || 0;
    score += Math.min(0.12, tasks * 0.02);
    if (!topicQuality.usable) score = Math.min(score, 0.5);
  }
  if (stage === 'results') {
    const finalStatus = result?.parsed?.final_status;
    if (finalStatus === 'SUCCESS') score += 0.18;
    if (finalStatus === 'PARTIAL_SUCCESS') score += 0.08;
    if (finalStatus === 'FAILURE') score -= 0.12;
    if (!topicQuality.usable) score = Math.min(score, 0.6);
  }
  if (stage === 'replication') {
    const trustLevel = result?.parsed?.trust?.level;
    const trustConfidence = Number(result?.parsed?.trust?.confidence || 0);
    if (trustLevel === 'HIGH') score += 0.22;
    if (trustLevel === 'MEDIUM') score += 0.1;
    if (trustLevel === 'LOW') score -= 0.16;
    score += Math.min(0.08, trustConfidence * 0.08);
    if (!topicQuality.usable) score = Math.min(score, 0.55);
  }

  if (context.peerReviewDecision === 'REJECT') score = Math.min(score, 0.35);

  score = clamp(score);
  return { reputation_score: Number(score.toFixed(2)), trust_level: trustLevelFromScore(score), topic_quality: topicQuality };
}

// UI setters for Agent Card displays
function setAgentStatus(agentKey, status) {
  const card = document.getElementById(`card-${agentKey}`);
  if (!card) return;
  card.dataset.status = status;
  const ind = card.querySelector('.agent-indicator');
  if (ind) ind.className = `agent-indicator ${status}`;
}

function updateAgentOutput(agentKey, data, error = null) {
  const el = document.getElementById(`output-${agentKey}`);
  if (!el) return;
  if (error) { el.innerHTML = `<div class="error-msg">❌ ${error}</div>`; return; }

  let content = data?.parsed || data?.raw || data;
  if (content && typeof content === 'object' && !Array.isArray(content) && (data?.retrieval || data?.provider)) {
    content = {
      _runtime: { provider: data.provider || 'unknown', model: data.model || 'unknown', fallbackReason: data.fallbackReason },
      _retrieval: data.retrieval ? { provider: data.retrieval.provider, embeddingModel: data.retrieval.embeddingModel, totalFetched: data.retrieval.totalFetched } : null,
      ...content
    };
  }
  
  if (typeof content === 'string') el.innerHTML = `<div class="raw-text">${escapeHtml(content)}</div>`;
  else el.innerHTML = `<pre class="json-output">${highlightJSON(content)}</pre>`;
}

async function runAgentStep(agentKey, agentName, fn) {
  setAgentStatus(agentKey, 'running');
  addStatusMessage(`▶ Running ${agentName}...`, 'info');
  setAgentStatusMsg(agentKey, `Processing data...`);
  
  const card = document.getElementById(`card-${agentKey}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  
  try {
    await fn();
    setAgentStatus(agentKey, 'done');
    setAgentStatusMsg(agentKey, `Complete ✓`);
    addStatusMessage(`✓ ${agentName} completed`, 'success');
  } catch (err) {
    setAgentStatus(agentKey, 'error');
    setAgentStatusMsg(agentKey, `Error: ${err.message}`);
    updateAgentOutput(agentKey, null, err.message);
    addStatusMessage(`✗ ${agentName} failed: ${err.message}`, 'error');
    throw err;
  }
}

function showSuccessModal() {
  const modal = document.getElementById('success-modal');
  if (modal) {
    modal.classList.add('visible');
    setTimeout(() => modal.classList.remove('visible'), 5000);
  }
}

// ─── MAIN ORCHESTRATOR ───────────────────────────────────────────
async function runPipeline() {
  if (state.running) return;
  const topic = document.getElementById('research-topic')?.value?.trim();
  if (!topic) { alert('Please enter a research topic first.'); return; }

  state.running = true;
  state.results = {};
  state.experimentId = generateExperimentId();

  document.getElementById('run-btn').disabled = true;
  document.getElementById('run-btn').textContent = '⚡ Running Pipeline...';

  Object.keys(AGENTS).forEach(k => {
    setAgentStatus(k, 'idle');
    setAgentStatusMsg(k, '');
    const out = document.getElementById(`output-${k}`);
    if (out) out.innerHTML = '<div class="waiting">Waiting...</div>';
  });

  await fetch(`${API_BASE}/api/hcs/log`, { method: 'DELETE' });
  await fetch(`${API_BASE}/api/hol/registry`, { method: 'DELETE' });

  addStatusMessage(`🧪 Starting experiment ${state.experimentId} on: "${topic}"`, 'info');

  try {
    // ── STEP 1: Hypothesis ──
    updatePipelineBanner('hypothesis');
    switchTab('hypothesis');
    await runAgentStep('hypothesis', 'Hypothesis Agent', async () => {
      setAgentStatusMsg('hypothesis', 'Searching Semantic Scholar and resolving relationships...');
      const prompt = AGENTS.hypothesis.buildPrompt(topic);
      const result = await callAgent('hypothesis', prompt, 4096, { topic });
      state.results.hypothesis = result.parsed || result;
      state.hypothesis = result.parsed || {};
      updateAgentOutput('hypothesis', result);

      await logToHCS({
        message_id: `msg-hyp-${Date.now()}`, agent_id: AGENTS.hypothesis.id, agent_type: 'HYPOTHESIS',
        action_type: 'HYPOTHESIS_GENERATED', experiment_id: state.experimentId,
        payload: { gaps_count: (result.parsed?.gaps || []).length, hypotheses_count: (result.parsed?.hypotheses || []).length }
      });
      const rep = computeStageReputation(topic, 'hypothesis', result);
      await updateHOL({ agent_id: AGENTS.hypothesis.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [state.experimentId] });
    });

    // ── STEP 2: Peer Review ──
    updatePipelineBanner('peerReview');
    switchTab('peerReview');
    const firstHypothesis = state.hypothesis?.hypotheses?.[0] || { statement: topic };
    await runAgentStep('peerReview', 'Peer Review Agent', async () => {
      setAgentStatusMsg('peerReview', 'Running 5-reviewer council validation logic...');
      const prompt = AGENTS.peerReview.buildPrompt(firstHypothesis);
      const result = await callAgent('peerReview', prompt, 4096, { hypothesis: firstHypothesis, experimentId: state.experimentId });
      state.results.peerReview = result.parsed || result;
      updateAgentOutput('peerReview', result);

      await logToHCS({
        message_id: `msg-pr-${Date.now()}`, agent_id: AGENTS.peerReview.id, agent_type: 'PEER_REVIEW',
        action_type: 'REVIEW_COMPLETED', experiment_id: state.experimentId,
        payload: { decision: result.parsed?.final_decision, confidence: result.parsed?.confidence }
      });
      const rep = computeStageReputation(topic, 'peerReview', result);
      await updateHOL({ agent_id: AGENTS.peerReview.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [] });
    });

    // ── STEP 3: Fundraising ──
    updatePipelineBanner('fundraising');
    switchTab('fundraising');
    await runAgentStep('fundraising', 'Fundraising Agent', async () => {
      setAgentStatusMsg('fundraising', 'Simulating investor marketplace matches via Hedera HTS...');
      const prompt = AGENTS.fundraising.buildPrompt(firstHypothesis, state.results.peerReview);
      const result = await callAgent('fundraising', prompt, 4096);
      state.results.fundraising = result.parsed || result;
      updateAgentOutput('fundraising', result);

      await fetch(`${API_BASE}/api/fundraising/campaigns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experimentId: state.experimentId, hypothesis: firstHypothesis, fundingResult: state.results.fundraising })
      });
      await refreshFundingStatus();

      await logToHCS({
        message_id: `msg-fund-${Date.now()}`, agent_id: AGENTS.fundraising.id, agent_type: 'FUNDRAISING',
        action_type: 'FUNDING_DECISION', experiment_id: state.experimentId,
        payload: { decision: result.parsed?.final_decision, total_raised: result.parsed?.funding_status?.total_raised }
      });
      const rep = computeStageReputation(topic, 'fundraising', result, { peerReviewDecision: state.results.peerReview?.final_decision });
      await updateHOL({ agent_id: AGENTS.fundraising.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [] });
    });

    if (state.results.fundraising?.final_decision === 'REJECTED') {
      updatePipelineBanner('idle');
      addStatusMessage('💀 Experiment rejected by investors. Pipeline halted.', 'error');
      ['labor', 'results', 'replication'].forEach(k => setAgentStatus(k, 'error'));
      return;
    }

    // ── STEP 4: Labor Market ──
    updatePipelineBanner('labor');
    switchTab('labor');
    await runAgentStep('labor', 'Labor Market Agent', async () => {
      setAgentStatusMsg('labor', 'Dispatching tasks via XMTP protocol and opening bounties...');
      const prompt = AGENTS.labor.buildPrompt(firstHypothesis, state.results.fundraising);
      const result = await callAgent('labor', prompt, 4096);
      state.results.labor = result.parsed || result;
      updateAgentOutput('labor', result);

      const marketplaceRes = await fetch(`${API_BASE}/api/labor/marketplaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experimentId: state.experimentId, hypothesis: firstHypothesis, laborResult: state.results.labor })
      });
      if (marketplaceRes.ok) {
        const payload = await marketplaceRes.json();
        await refreshLaborStatus();
        addStatusMessage(`Labor marketplace ${payload.marketplace?.id} opened with ${payload.marketplace?.tasks?.length || 0} tasks.`, 'success');
      }

      await logToHCS({
        message_id: `msg-lab-${Date.now()}`, agent_id: AGENTS.labor.id, agent_type: 'LABOR',
        action_type: 'TASKS_PUBLISHED', experiment_id: state.experimentId,
        payload: { tasks_count: result.parsed?.tasks?.length || 0, token: 'EXP_TOKEN', total_allocated: result.parsed?.hedera?.token_service?.total_allocated }
      });
      const rep = computeStageReputation(topic, 'labor', result, { peerReviewDecision: state.results.peerReview?.final_decision });
      await updateHOL({ agent_id: AGENTS.labor.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [] });
    });

    // ── STEP 5: Results ──
    updatePipelineBanner('results');
    switchTab('results');
    await runAgentStep('results', 'Results Agent', async () => {
      setAgentStatusMsg('results', 'Compiling final metric blob and interacting with IPFS + HTS...');
      const prompt = AGENTS.results.buildPrompt(firstHypothesis, state.results.labor);
      const result = await callAgent('results', prompt, 4096, {
        hypothesis: firstHypothesis, experimentId: state.experimentId, laborResult: state.results.labor
      });
      state.results.results = result.parsed || result;
      updateAgentOutput('results', result);

      const hcsLogRes = await logToHCS({
        message_id: `msg-res-${Date.now()}`, agent_id: AGENTS.results.id, agent_type: 'RESULTS',
        action_type: 'RESULT_PUBLISHED', experiment_id: state.experimentId,
        payload: { status: result.parsed?.final_status, metrics: result.parsed?.metrics, nft_token_id: result.parsed?.hedera_record?.nft_token_id }
      });
      if (hcsLogRes?.entry?.hedera?.hts?.token_id) {
        state.results.results.hedera_record = {
          nft_token_id: hcsLogRes.entry.hedera.hts.token_id,
          nft_serials: hcsLogRes.entry.hedera.hts.serials || []
        };
      }
      const rep = computeStageReputation(topic, 'results', result, { peerReviewDecision: state.results.peerReview?.final_decision });
      await updateHOL({ agent_id: AGENTS.results.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [state.experimentId] });
    });

    // ── STEP 6: Replication ──
    updatePipelineBanner('replication');
    switchTab('replication');
    await runAgentStep('replication', 'Replication Agent', async () => {
      setAgentStatusMsg('replication', 'Verifying outcomes against hypothesis and setting NFT reputation score...');
      const prompt = AGENTS.replication.buildPrompt(firstHypothesis, state.results.results);
      const result = await callAgent('replication', prompt, 4096, {
        hypothesis: firstHypothesis, experimentId: state.experimentId, resultsData: state.results.results
      });
      state.results.replication = result.parsed || result;
      updateAgentOutput('replication', result);

      await logToHCS({
        message_id: `msg-rep-${Date.now()}`, agent_id: AGENTS.replication.id, agent_type: 'REPLICATION',
        action_type: 'REPLICATION_DONE', experiment_id: state.experimentId,
        payload: { verdict: result.parsed?.final_verdict, trust_level: result.parsed?.trust?.level, deviation: result.parsed?.comparison?.deviation }
      });
      const rep = computeStageReputation(topic, 'replication', result, { peerReviewDecision: state.results.peerReview?.final_decision });
      await updateHOL({ agent_id: AGENTS.replication.id, reputation_score: rep.reputation_score, trust_level: rep.trust_level, contributions: [state.experimentId], owned_experiments: [] });
    });

    updatePipelineBanner('done');
    addStatusMessage(`✅ Experiment ${state.experimentId} completed successfully!`, 'success');
    showSuccessModal();

  } catch (err) {
    updatePipelineBanner('idle');
    addStatusMessage(`❌ Pipeline error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    state.running = false;
    document.getElementById('run-btn').disabled = false;
    document.getElementById('run-btn').textContent = '⚡ Run Experiment';
  }
}
