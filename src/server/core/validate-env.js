/**
 * ALCHEMY Protocol — Environment Validation
 * Checks all required and optional env variables at startup,
 * printing clear actionable warnings instead of silent crashes.
 */

const CHECKS = [
  {
    key: 'MISTRAL_API_KEY',
    level: 'error',
    placeholders: ['your_mistral_api_key_here'],
    hint: 'Add your Mistral API key from https://console.mistral.ai/ — the AI agents cannot run without it.'
  },
  {
    key: 'HEDERA_ACCOUNT_ID',
    level: 'warn',
    placeholders: ['0.0.XXXXXXX'],
    hint: 'Set HEDERA_ACCOUNT_ID (e.g. 0.0.1234567) to enable real on-chain HCS/HTS transactions.'
  },
  {
    key: 'HEDERA_PRIVATE_KEY',
    level: 'warn',
    placeholders: ['302e...'],
    hint: 'Set HEDERA_PRIVATE_KEY (DER-encoded, starts with 302e…) for Hedera signing.'
  },
  {
    key: 'HCS_TOPIC_ID',
    level: 'warn',
    placeholders: ['0.0.XXXXXXX'],
    hint: 'Set HCS_TOPIC_ID to enable real Hedera Consensus Service logging. Create one via https://portal.hedera.com.'
  },
  {
    key: 'REGISTRY_BROKER_API_KEY',
    level: 'warn',
    placeholders: ['rbk_...'],
    hint: 'Set REGISTRY_BROKER_API_KEY to enable full HOL Registry Broker registration. Get it from the HOL developer portal.'
  },
  {
    key: 'AGENT_NAME',
    level: 'info',
    hint: 'AGENT_NAME not set. Defaulting to "ALCHEMY Protocol Agent".'
  },
  {
    key: 'AGENT_ALIAS',
    level: 'info',
    hint: 'AGENT_ALIAS not set. Defaulting to "alchemy_protocol".'
  },
  {
    key: 'PUBLIC_APP_URL',
    level: 'info',
    hint: 'PUBLIC_APP_URL not set. Using http://localhost:3000 for agent card links. Set this in production.'
  }
];

const HEDERA_ACCOUNT_REGEX = /^0\.0\.\d+$/;
const HEDERA_KEY_REGEX = /^(302[e-f]|[0-9a-fA-F]{64})/;

/**
 * Validates a single env key against its configuration.
 * @param {object} check
 * @returns {{ key, ok, level, message } | null}
 */
function validateOne(check) {
  const raw = process.env[check.key];
  const missing = !raw || !raw.trim();
  const isPlaceholder = !missing && check.placeholders && check.placeholders.includes(raw.trim());

  if (missing || isPlaceholder) {
    return {
      key: check.key,
      ok: false,
      level: check.level,
      message: check.hint || `${check.key} is not configured.`
    };
  }

  return null;
}

/**
 * Validates Hedera account ID format if set.
 */
function validateHederaFormats(issues) {
  const aid = process.env.HEDERA_ACCOUNT_ID;
  if (aid && aid.trim() && !HEDERA_ACCOUNT_REGEX.test(aid.trim())) {
    issues.push({
      key: 'HEDERA_ACCOUNT_ID',
      ok: false,
      level: 'error',
      message: `HEDERA_ACCOUNT_ID "${aid}" does not match expected format 0.0.XXXXXXX.`
    });
  }

  const pk = process.env.HEDERA_PRIVATE_KEY;
  if (pk && pk.trim() && !HEDERA_KEY_REGEX.test(pk.trim())) {
    issues.push({
      key: 'HEDERA_PRIVATE_KEY',
      ok: false,
      level: 'warn',
      message: 'HEDERA_PRIVATE_KEY format looks unexpected. Ensure it is a DER-encoded key (starts with 302e…) or a raw hex seed.'
    });
  }
}

const ICONS = { error: '✗', warn: '⚠', info: 'ℹ' };
const COLORS = {
  error: '\x1b[31m',   // red
  warn: '\x1b[33m',    // yellow
  info: '\x1b[36m',    // cyan
  reset: '\x1b[0m'
};

/**
 * Runs all env checks and prints a report.
 * @returns {boolean} false if any ERROR-level checks failed.
 */
function validateEnv() {
  const issues = CHECKS.map(validateOne).filter(Boolean);
  validateHederaFormats(issues);

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warn');
  const infos = issues.filter(i => i.level === 'info');

  if (issues.length === 0) {
    console.log('\x1b[32m✓ All environment variables are configured correctly.\x1b[0m');
    return true;
  }

  console.log('\n─── ALCHEMY Environment Validation ──────────────────────────────');

  for (const issue of [...errors, ...warnings, ...infos]) {
    const color = COLORS[issue.level] || COLORS.reset;
    const icon = ICONS[issue.level] || 'ℹ';
    console.log(`${color}${icon} [${issue.key}] ${issue.message}${COLORS.reset}`);
  }

  console.log('──────────────────────────────────────────────────────────────────\n');

  if (errors.length > 0) {
    console.error(`\x1b[31m✗ ${errors.length} critical environment variable(s) are missing. The server may not function correctly.\x1b[0m\n`);
    return false;
  }

  if (warnings.length > 0) {
    console.warn(`\x1b[33m⚠ ${warnings.length} optional environment variable(s) are not set. Some features will run in simulated mode.\x1b[0m\n`);
  }

  return true;
}

module.exports = { validateEnv };
