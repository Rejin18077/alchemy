const { markDatabaseDirty } = require('../db/sqlite');

function registerResultsRoutes({
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
}) {
  app.get('/api/results/registry', (req, res) => {
    const experimentId = req.query.experimentId ? String(req.query.experimentId) : null;
    const records = Array.from(resultsState.registry.values());
    if (experimentId) {
      return res.json(records.filter((record) => record.experimentId === experimentId));
    }
    res.json(records);
  });

  app.get('/api/results/status', (req, res) => {
    res.json({
      status: 'ok',
      config: getResultsStatus()
    });
  });

  app.get('/api/replication/status', (req, res) => {
    res.json({
      status: 'ok',
      config: getReplicationStatus(),
      marketplaces: Array.from(replicationState.marketplaces.values()).map(serializeReplicationMarketplace)
    });
  });

  app.post('/api/replication/marketplaces', async (req, res) => {
    const { experimentId, resultsData } = req.body || {};
    if (!experimentId || !resultsData) {
      return res.status(400).json({ error: 'experimentId and resultsData are required' });
    }

    try {
      const marketplace = createReplicationMarketplace({ experimentId, resultsData });
      await logLaborEvent({
        message_id: `msg-repl-market-${Date.now()}`,
        agent_id: 'replication-marketplace-001',
        agent_type: 'REPLICATION',
        action_type: 'REPLICATION_MARKETPLACE_OPENED',
        experiment_id: experimentId,
        payload: {
          marketplace_id: marketplace.id,
          tasks_count: marketplace.taskIds.length,
          manifest_hash: marketplace.manifestHash
        }
      });
      res.json({ marketplace: serializeReplicationMarketplace(marketplace) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/replication/tasks', (req, res) => {
    const experimentId = req.query.experimentId ? String(req.query.experimentId) : null;
    const tasks = Array.from(replicationState.tasks.values())
      .filter((task) => !experimentId || task.experimentId === experimentId)
      .map(serializeReplicationTask);
    res.json(tasks);
  });

  app.post('/api/replication/workers', (req, res) => {
    try {
      const worker = upsertReplicationWorker(req.body || {});
      res.json({ worker });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replication/tasks/:taskId/claim', async (req, res) => {
    const task = replicationState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Replication task not found' });
    }
    if (task.status !== 'OPEN') {
      return res.status(400).json({ error: 'Replication task is not open for claims' });
    }

    try {
      const worker = upsertReplicationWorker(req.body || {});
      task.status = 'CLAIMED';
      task.assignedWorkerAccountId = worker.accountId;
      task.claims.unshift({
        workerAccountId: worker.accountId,
        claimedAt: new Date().toISOString()
      });
      markDatabaseDirty();
      await logLaborEvent({
        message_id: `msg-repl-claim-${Date.now()}`,
        agent_id: 'replication-marketplace-001',
        agent_type: 'REPLICATION',
        action_type: 'REPLICATION_TASK_CLAIMED',
        experiment_id: task.experimentId,
        payload: {
          task_id: task.id,
          worker_account_id: worker.accountId
        }
      });
      res.json({ task: serializeReplicationTask(task) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/replication/tasks/:taskId/submit', async (req, res) => {
    const task = replicationState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Replication task not found' });
    }
    const { workerAccountId, proof, resultSummary, artifacts = [] } = req.body || {};
    if (!workerAccountId || String(workerAccountId) !== String(task.assignedWorkerAccountId)) {
      return res.status(400).json({ error: 'Submission must come from the assigned replication worker' });
    }

    const submission = {
      id: `repl-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: task.id,
      workerAccountId: String(workerAccountId),
      proof: proof ? String(proof) : '',
      resultSummary: resultSummary ? String(resultSummary) : '',
      artifacts: Array.isArray(artifacts) ? artifacts.map(String) : [],
      createdAt: new Date().toISOString(),
      status: 'PENDING_VERIFICATION'
    };

    replicationState.submissions.unshift(submission);
    task.submissions.unshift(submission);
    task.status = 'SUBMITTED';
    markDatabaseDirty();

    await logLaborEvent({
      message_id: `msg-repl-submit-${Date.now()}`,
      agent_id: 'replication-marketplace-001',
      agent_type: 'REPLICATION',
      action_type: 'REPLICATION_TASK_SUBMITTED',
      experiment_id: task.experimentId,
      payload: {
        task_id: task.id,
        worker_account_id: workerAccountId,
        submission_id: submission.id
      }
    });

    res.json({ submission, task: serializeReplicationTask(task) });
  });

  app.post('/api/replication/tasks/:taskId/verify', async (req, res) => {
    const task = replicationState.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Replication task not found' });
    }
    const submission = task.submissions[0];
    if (!submission) {
      return res.status(400).json({ error: 'No replication submission available for verification' });
    }

    const verdict = String(req.body?.verdict || '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'REVISION_REQUIRED'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be APPROVED, REJECTED, or REVISION_REQUIRED' });
    }

    submission.status = verdict;
    task.verification = {
      verdict,
      notes: req.body?.notes ? String(req.body.notes) : '',
      verifier: req.body?.verifier ? String(req.body.verifier) : 'replication-verifier-001',
      verifiedAt: new Date().toISOString()
    };

    if (verdict === 'APPROVED') {
      task.status = 'VERIFIED';
    } else if (verdict === 'REVISION_REQUIRED') {
      task.status = 'CLAIMED';
    } else {
      task.status = 'OPEN';
      task.assignedWorkerAccountId = null;
    }
    markDatabaseDirty();

    await logLaborEvent({
      message_id: `msg-repl-verify-${Date.now()}`,
      agent_id: task.verification.verifier,
      agent_type: 'REPLICATION',
      action_type: 'REPLICATION_TASK_VERIFIED',
      experiment_id: task.experimentId,
      payload: {
        task_id: task.id,
        verdict,
        worker_account_id: submission.workerAccountId
      }
    });

    res.json({ task: serializeReplicationTask(task), submission, verification: task.verification });
  });
}

module.exports = {
  registerResultsRoutes
};
