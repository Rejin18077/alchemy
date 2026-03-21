const {
  hederaState,
  loadHederaSdk,
  getHederaMode,
  parseTokenAmount
} = require('../core/runtime');

function createHederaClient(sdk) {
  if (!process.env.HEDERA_ACCOUNT_ID || !process.env.HEDERA_PRIVATE_KEY) {
    throw new Error('Hedera operator credentials are missing');
  }

  const network = (process.env.HEDERA_NETWORK || 'testnet').toLowerCase();
  const client = network === 'mainnet' ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
  const privateKey = sdk.PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY);
  client.setOperator(process.env.HEDERA_ACCOUNT_ID, privateKey);
  return { client, privateKey };
}

function buildNftMetadata(entry) {
  const compact = JSON.stringify({
    exp: entry.experiment_id,
    action: entry.action_type,
    status: entry.payload?.status || entry.payload?.verdict || 'NA',
    ts: new Date().toISOString()
  });
  const safe = Buffer.byteLength(compact, 'utf8') > 100 ? compact.slice(0, 100) : compact;
  return Buffer.from(safe, 'utf8');
}

async function submitMessageToHCS(entry) {
  const sdk = loadHederaSdk();
  const mode = getHederaMode();
  if (!sdk || mode.hcs !== 'enabled') {
    return { mode: 'simulated', submitted: false, reason: 'HCS not fully configured' };
  }

  const { client } = createHederaClient(sdk);
  try {
    const response = await new sdk.TopicMessageSubmitTransaction()
      .setTopicId(process.env.HCS_TOPIC_ID)
      .setMessage(JSON.stringify(entry))
      .execute(client);

    const receipt = await response.getReceipt(client);
    return {
      mode: 'hedera',
      submitted: true,
      topic_id: process.env.HCS_TOPIC_ID,
      transaction_id: response.transactionId.toString(),
      sequence_number: receipt.topicSequenceNumber ? String(receipt.topicSequenceNumber) : null
    };
  } finally {
    client.close();
  }
}

async function ensureExpToken(client, sdk, privateKey) {
  if (hederaState.expTokenId) {
    return hederaState.expTokenId;
  }

  const createTx = await new sdk.TokenCreateTransaction()
    .setTokenName(process.env.HTS_EXP_TOKEN_NAME || 'ALCHEMY EXP Token')
    .setTokenSymbol(process.env.HTS_EXP_TOKEN_SYMBOL || 'EXP')
    .setTokenType(sdk.TokenType.FungibleCommon)
    .setDecimals(Number(process.env.HTS_EXP_TOKEN_DECIMALS || 0))
    .setInitialSupply(0)
    .setTreasuryAccountId(process.env.HEDERA_ACCOUNT_ID)
    .setAdminKey(privateKey.publicKey)
    .setSupplyKey(privateKey.publicKey)
    .setSupplyType(sdk.TokenSupplyType.Infinite)
    .freezeWith(client)
    .sign(privateKey);

  const submit = await createTx.execute(client);
  const receipt = await submit.getReceipt(client);
  hederaState.expTokenId = receipt.tokenId.toString();
  return hederaState.expTokenId;
}

async function ensurePublicationToken(client, sdk, privateKey) {
  if (hederaState.publicationTokenId) {
    return hederaState.publicationTokenId;
  }

  const createTx = await new sdk.TokenCreateTransaction()
    .setTokenName(process.env.HTS_PUBLICATION_TOKEN_NAME || 'ALCHEMY Publication NFT')
    .setTokenSymbol(process.env.HTS_PUBLICATION_TOKEN_SYMBOL || 'ALCHPUB')
    .setTokenType(sdk.TokenType.NonFungibleUnique)
    .setInitialSupply(0)
    .setTreasuryAccountId(process.env.HEDERA_ACCOUNT_ID)
    .setAdminKey(privateKey.publicKey)
    .setSupplyKey(privateKey.publicKey)
    .setSupplyType(sdk.TokenSupplyType.Infinite)
    .freezeWith(client)
    .sign(privateKey);

  const submit = await createTx.execute(client);
  const receipt = await submit.getReceipt(client);
  hederaState.publicationTokenId = receipt.tokenId.toString();
  return hederaState.publicationTokenId;
}

async function syncHTSForEntry(entry) {
  const sdk = loadHederaSdk();
  const mode = getHederaMode();
  if (!sdk || mode.hts !== 'enabled') {
    return { mode: 'simulated', executed: false, reason: 'HTS not fully configured' };
  }

  const { client, privateKey } = createHederaClient(sdk);
  try {
    if (entry.action_type === 'TASKS_PUBLISHED') {
      const amount = parseTokenAmount(entry.payload?.total_allocated, 0);
      const tokenId = await ensureExpToken(client, sdk, privateKey);

      if (amount > 0) {
        const mintTx = await new sdk.TokenMintTransaction()
          .setTokenId(tokenId)
          .setAmount(amount)
          .freezeWith(client)
          .sign(privateKey);
        await mintTx.execute(client);
      }

      return {
        mode: 'hedera',
        executed: true,
        action: 'EXP_TOKEN_MINTED',
        token_id: tokenId,
        amount
      };
    }

    if (entry.action_type === 'RESULT_PUBLISHED') {
      const tokenId = await ensurePublicationToken(client, sdk, privateKey);
      const mintTx = await new sdk.TokenMintTransaction()
        .setTokenId(tokenId)
        .setMetadata([buildNftMetadata(entry)])
        .freezeWith(client)
        .sign(privateKey);
      const submit = await mintTx.execute(client);
      const receipt = await submit.getReceipt(client);

      return {
        mode: 'hedera',
        executed: true,
        action: 'PUBLICATION_NFT_MINTED',
        token_id: tokenId,
        serials: (receipt.serials || []).map(String)
      };
    }

    return { mode: 'hedera', executed: false, reason: 'No HTS action mapped for this event' };
  } finally {
    client.close();
  }
}

module.exports = {
  createHederaClient,
  buildNftMetadata,
  submitMessageToHCS,
  ensureExpToken,
  ensurePublicationToken,
  syncHTSForEntry
};
