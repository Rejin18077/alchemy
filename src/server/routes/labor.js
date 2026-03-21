const { markDatabaseDirty } = require('../db/sqlite');

function registerLaborRoutes({
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
}) {
  app.get('/api/labor/status', (req, res) => {
    res.json({
      status: 'ok',
      config: getLaborStatus(),
      marketplaces: Array.from(laborState.marketplaces.values()).map(serializeMarketplace)
    });
  });

  app.post('/api/labor/marketplaces', async (req, res) => {
    const { experimentId, hypothesis, laborResult } = req.body || {};
    if (!laborResult) {
      return res.status(400).json({ error: 'laborResult is required' });
    }

    try {
      const marketplace = createLaborMarketplace({ experimentId, hypothesis, laborResult });
      await logLaborEvent({
        message_id: `msg-labor-market-${Date.now()}`,
        agent_id: 'labor-marketplace-001',
        agent_type: 'LABOR',
        action_type: 'TASK_MARKETPLACE_OPENED',
        experiment_id: marketplace.experimentId,
        payload: {
          marketplace_id: marketplace.id,
          tasks_count: marketplace.taskIds.length,
          payout_asset: marketplace.payoutAsset
        }
      });
      res.json({ marketplace: serializeMarketplace(marketplace) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/labor/tasks', (req, res) => {
    const marketplaceId = req.query.marketplaceId ? String(req.query.marketplaceId) : null;
    const tasks = Array.from(laborState.tasks.values())
      .filter((task) => !marketplaceId || task.marketplaceId === marketplaceId)
      .map(serializeTask);
    res.json(tasks);
  });

  app.post('/api/labor/workers', (req, res) => {
    try {
      const worker = upsertWorkerProfile(req.body || {});
      res.json({ worker });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/labor/workers', (req, res) => {
    res.json(Array.from(laborState.workers.values()));
  });

  app.post('/api/labor/tasks/:taskId/claim', async (req, res) => {
    const task = laborState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.status !== 'OPEN') {
      return res.status(400).json({ error: 'Task is not open for claims' });
    }

    try {
      const worker = upsertWorkerProfile(req.body || {});
      task.status = 'CLAIMED';
      task.assignedWorkerAccountId = worker.accountId;
      task.claims.unshift({
        workerAccountId: worker.accountId,
        claimedAt: new Date().toISOString(),
        xmtpDispatched: Boolean(getLaborConfig().xmtpEnabled && worker.xmtpAddress)
      });
      markDatabaseDirty();

      await logLaborEvent({
        message_id: `msg-task-claim-${Date.now()}`,
        agent_id: 'labor-marketplace-001',
        agent_type: 'LABOR',
        action_type: 'TASK_CLAIMED',
        experiment_id: task.experimentId,
        payload: {
          task_id: task.id,
          worker_account_id: worker.accountId,
          xmtp_dispatched: Boolean(getLaborConfig().xmtpEnabled && worker.xmtpAddress)
        }
      });

      res.json({
        task: serializeTask(task),
        dispatch: {
          channel: getLaborConfig().xmtpEnabled ? 'XMTP' : 'REST',
          queued: Boolean(getLaborConfig().xmtpEnabled),
          recipient: worker.xmtpAddress || null,
          message: `Claim confirmed for ${task.id}. Complete the task and submit proof through the labor API.`
        }
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/labor/tasks/:taskId/submit', async (req, res) => {
    const task = laborState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const { workerAccountId, proof, resultSummary, artifacts = [] } = req.body || {};
    if (!workerAccountId || String(workerAccountId) !== String(task.assignedWorkerAccountId)) {
      return res.status(400).json({ error: 'Submission must come from the assigned worker' });
    }
    if (!proof && !resultSummary) {
      return res.status(400).json({ error: 'proof or resultSummary is required' });
    }

    const submission = {
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: task.id,
      workerAccountId: String(workerAccountId),
      proof: proof ? String(proof) : '',
      resultSummary: resultSummary ? String(resultSummary) : '',
      artifacts: Array.isArray(artifacts) ? artifacts.map(String) : [],
      createdAt: new Date().toISOString(),
      status: 'PENDING_VERIFICATION'
    };

    laborState.submissions.unshift(submission);
    task.submissions.unshift(submission);
    task.status = 'SUBMITTED';
    markDatabaseDirty();

    await logLaborEvent({
      message_id: `msg-task-submit-${Date.now()}`,
      agent_id: 'labor-marketplace-001',
      agent_type: 'LABOR',
      action_type: 'TASK_SUBMITTED',
      experiment_id: task.experimentId,
      payload: {
        task_id: task.id,
        worker_account_id: workerAccountId,
        submission_id: submission.id
      }
    });

    res.json({ submission, task: serializeTask(task) });
  });

  app.post('/api/labor/tasks/:taskId/verify', async (req, res) => {
    const task = laborState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const submission = task.submissions[0];
    if (!submission) {
      return res.status(400).json({ error: 'No submission available for verification' });
    }

    const { verdict, notes, verifier = 'labor-verifier-001', payoutAmount } = req.body || {};
    const normalizedVerdict = String(verdict || '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'REVISION_REQUIRED'].includes(normalizedVerdict)) {
      return res.status(400).json({ error: 'verdict must be APPROVED, REJECTED, or REVISION_REQUIRED' });
    }

    submission.status = normalizedVerdict;
    task.verification = {
      verdict: normalizedVerdict,
      notes: notes ? String(notes) : '',
      verifier: String(verifier),
      verifiedAt: new Date().toISOString()
    };

    if (normalizedVerdict === 'APPROVED') {
      task.status = 'VERIFIED';
      const amount = parseTokenAmount(payoutAmount, task.reward) * getLaborConfig().payoutMultiplier;
      const payout = await transferExpToWorker(task.assignedWorkerAccountId, amount);
      task.payout = {
        amount,
        asset: getLaborConfig().payoutAsset,
        workerAccountId: task.assignedWorkerAccountId,
        executedAt: new Date().toISOString(),
        ...payout
      };
    } else if (normalizedVerdict === 'REVISION_REQUIRED') {
      task.status = 'CLAIMED';
    } else {
      task.status = 'OPEN';
      task.assignedWorkerAccountId = null;
    }
    markDatabaseDirty();

    await logLaborEvent({
      message_id: `msg-task-verify-${Date.now()}`,
      agent_id: String(verifier),
      agent_type: 'LABOR',
      action_type: 'TASK_VERIFIED',
      experiment_id: task.experimentId,
      payload: {
        task_id: task.id,
        verdict: normalizedVerdict,
        worker_account_id: submission.workerAccountId,
        payout: task.payout || null
      }
    });

    res.json({ task: serializeTask(task), submission, verification: task.verification, payout: task.payout });
  });
}

module.exports = {
  registerLaborRoutes
};
