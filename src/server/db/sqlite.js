const fs = require('fs');
const path = require('path');
const Database = require("better-sqlite3");

let db = null;
let context = null;
let autosaveTimer = null;
let dirty = false;
let initialized = false;
let lastPersistAt = null;

function promisifyRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function promisifyGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function promisifyAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const database = new Database(filename, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(database);
    });
  });
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function serializeCampaigns(campaignsMap) {
  return Array.from(campaignsMap.values()).map((campaign) => ({
    ...campaign,
    investors: Array.from(campaign.investors.values())
  }));
}

function deserializeCampaigns(records) {
  const map = new Map();
  for (const campaign of records || []) {
    map.set(campaign.id, {
      ...campaign,
      investors: new Map((campaign.investors || []).map((investor) => [investor.accountId, investor]))
    });
  }
  return map;
}

function snapshotState() {
  return {
    hedera_state: {
      expTokenId: context.hederaState.expTokenId,
      publicationTokenId: context.hederaState.publicationTokenId
    },
    hcs_log: context.hcsLog,
    hol_registry: context.holRegistry,
    chat_history: context.agentRuntime.chatHistory,
    funding_campaigns: serializeCampaigns(context.fundingState.campaigns),
    funding_investors: Array.from(context.fundingState.investors.values()),
    funding_contributions: context.fundingState.contributions,
    labor_marketplaces: Array.from(context.laborState.marketplaces.values()),
    labor_tasks: Array.from(context.laborState.tasks.values()),
    labor_workers: Array.from(context.laborState.workers.values()),
    labor_submissions: context.laborState.submissions,
    results_registry: Array.from(context.resultsState.registry.values()),
    results_bundles: Array.from(context.resultsState.bundles.entries()),
    replication_marketplaces: Array.from(context.replicationState.marketplaces.values()),
    replication_tasks: Array.from(context.replicationState.tasks.values()),
    replication_workers: Array.from(context.replicationState.workers.values()),
    replication_submissions: context.replicationState.submissions
  };
}

function hydrateState(snapshots) {
  const hederaState = snapshots.hedera_state || {};
  context.hederaState.expTokenId = hederaState.expTokenId || context.hederaState.expTokenId || null;
  context.hederaState.publicationTokenId = hederaState.publicationTokenId || context.hederaState.publicationTokenId || null;

  context.hcsLog.length = 0;
  context.hcsLog.push(...(snapshots.hcs_log || []));

  Object.keys(context.holRegistry).forEach((key) => delete context.holRegistry[key]);
  Object.assign(context.holRegistry, snapshots.hol_registry || {});

  context.agentRuntime.chatHistory.length = 0;
  context.agentRuntime.chatHistory.push(...(snapshots.chat_history || []));

  context.fundingState.campaigns = deserializeCampaigns(snapshots.funding_campaigns || []);
  context.fundingState.investors = new Map((snapshots.funding_investors || []).map((investor) => [investor.accountId, investor]));
  context.fundingState.contributions = snapshots.funding_contributions || [];

  context.laborState.marketplaces = new Map((snapshots.labor_marketplaces || []).map((item) => [item.id, item]));
  context.laborState.tasks = new Map((snapshots.labor_tasks || []).map((item) => [item.id, item]));
  context.laborState.workers = new Map((snapshots.labor_workers || []).map((item) => [item.accountId, item]));
  context.laborState.submissions = snapshots.labor_submissions || [];

  context.resultsState.registry = new Map((snapshots.results_registry || []).map((item) => [item.experimentId, item]));
  context.resultsState.bundles = new Map(snapshots.results_bundles || []);

  context.replicationState.marketplaces = new Map((snapshots.replication_marketplaces || []).map((item) => [item.id, item]));
  context.replicationState.tasks = new Map((snapshots.replication_tasks || []).map((item) => [item.id, item]));
  context.replicationState.workers = new Map((snapshots.replication_workers || []).map((item) => [item.accountId, item]));
  context.replicationState.submissions = snapshots.replication_submissions || [];
}

async function initializeDatabase(options) {
  context = options;
  const dataDir = path.join(options.projectRoot, 'data');
  await fs.promises.mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'alchemy.db');
  db = await openDatabase(dbPath);

  await promisifyRun(
    db,
    `CREATE TABLE IF NOT EXISTS state_snapshots (
      scope TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  const rows = await promisifyAll(db, 'SELECT scope, payload FROM state_snapshots');
  if (rows.length) {
    const snapshots = {};
    for (const row of rows) {
      try {
        snapshots[row.scope] = JSON.parse(row.payload);
      } catch {
        // Ignore invalid persisted payloads and keep current in-memory state.
      }
    }
    hydrateState(snapshots);
  }

  initialized = true;
  dirty = false;
  return {
    engine: 'sqlite',
    path: dbPath
  };
}

function markDatabaseDirty() {
  dirty = true;
}

async function flushDatabaseState() {
  if (!initialized || !db || !dirty) {
    return;
  }

  const snapshots = snapshotState();
  const now = new Date().toISOString();
  await promisifyRun(db, 'BEGIN TRANSACTION');
  try {
    for (const [scope, payload] of Object.entries(snapshots)) {
      await promisifyRun(
        db,
        `INSERT INTO state_snapshots (scope, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [scope, JSON.stringify(payload), now]
      );
    }
    await promisifyRun(db, 'COMMIT');
    dirty = false;
    lastPersistAt = now;
  } catch (err) {
    await promisifyRun(db, 'ROLLBACK');
    throw err;
  }
}

function startDatabaseAutosave(intervalMs = 2000) {
  if (autosaveTimer) {
    clearInterval(autosaveTimer);
  }

  autosaveTimer = setInterval(() => {
    flushDatabaseState().catch(() => { });
  }, intervalMs);
  autosaveTimer.unref?.();
}

async function shutdownDatabase() {
  if (autosaveTimer) {
    clearInterval(autosaveTimer);
    autosaveTimer = null;
  }

  await flushDatabaseState();
  if (db) {
    await closeDatabase(db);
    db = null;
  }
}

function getDatabaseStatus() {
  return {
    enabled: initialized,
    engine: 'sqlite',
    lastPersistAt
  };
}

module.exports = {
  initializeDatabase,
  markDatabaseDirty,
  flushDatabaseState,
  startDatabaseAutosave,
  shutdownDatabase,
  getDatabaseStatus
};
