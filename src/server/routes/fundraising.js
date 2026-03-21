const { markDatabaseDirty } = require('../db/sqlite');

function registerFundingRoutes({
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
}) {
  app.get('/api/fundraising/status', (req, res) => {
    res.json({
      status: 'ok',
      config: getFundraisingStatus(),
      campaigns: Array.from(fundingState.campaigns.values()).map(serializeCampaign)
    });
  });

  app.get('/api/fundraising/campaigns', (req, res) => {
    res.json(Array.from(fundingState.campaigns.values()).map(serializeCampaign));
  });

  app.post('/api/fundraising/campaigns', (req, res) => {
    const { experimentId, hypothesis, fundingResult } = req.body || {};
    if (!fundingResult) {
      return res.status(400).json({ error: 'fundingResult is required' });
    }

    try {
      const campaign = createCampaignFromFundingResult({
        experimentId,
        hypothesis,
        fundingResult,
        createdBy: 'api'
      });
      res.json({ campaign: serializeCampaign(campaign) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/fundraising/investors', (req, res) => {
    try {
      const investor = upsertInvestorProfile(req.body || {});
      res.json({ investor });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/fundraising/investors', (req, res) => {
    res.json(Array.from(fundingState.investors.values()));
  });

  app.post('/api/fundraising/match', (req, res) => {
    try {
      const investor = upsertInvestorProfile(req.body || {});
      const matches = Array.from(fundingState.campaigns.values())
        .map((campaign) => ({
          campaign: serializeCampaign(campaign),
          score: scoreCampaignMatch(investor, campaign)
        }))
        .sort((a, b) => b.score - a.score);
      res.json({ investor, matches });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/fundraising/contribution-intents', (req, res) => {
    const { campaignId, contributorAccountId, amountUsd, displayName, riskAppetite, walletProvider, alias } = req.body || {};
    const campaign = fundingState.campaigns.get(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const numericUsd = Number(parseCurrencyAmount(amountUsd, 0));
    const cfg = getFundingConfig();
    if (!contributorAccountId) {
      return res.status(400).json({ error: 'contributorAccountId is required' });
    }
    if (numericUsd < cfg.minContributionUsd) {
      return res.status(400).json({ error: `Minimum contribution is $${cfg.minContributionUsd}` });
    }

    try {
      const investor = upsertInvestorProfile({
        accountId: contributorAccountId,
        displayName,
        riskAppetite,
        walletProvider,
        alias
      });
      const amountTinybar = toTinybarFromUsd(numericUsd);
      const intent = createContributionIntent({
        campaign,
        investor,
        amountUsd: numericUsd,
        amountTinybar
      });
      res.json({ intent, investor, campaign: serializeCampaign(campaign) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/fundraising/contributions/record', async (req, res) => {
    const {
      campaignId,
      contributorAccountId,
      amountUsd,
      transactionId,
      verifyOnMirrorNode = true
    } = req.body || {};

    try {
      const campaign = fundingState.campaigns.get(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const numericUsd = Number(parseCurrencyAmount(amountUsd, 0));
      if (!numericUsd) {
        return res.status(400).json({ error: 'amountUsd is required' });
      }

      const minTinybar = toTinybarFromUsd(numericUsd);
      let mirrorVerification = null;
      let verificationMode = 'manual';

      if (verifyOnMirrorNode && transactionId && campaign.treasuryAccountId) {
        mirrorVerification = await verifyMirrorNodeContribution({
          transactionId,
          contributorAccountId,
          campaign,
          minTinybar
        });
        verificationMode = 'mirror-node';
      }

      const contribution = await recordContribution({
        campaignId,
        contributorAccountId,
        amountUsd: numericUsd,
        amountTinybar: mirrorVerification?.treasuryAmountTinybar || minTinybar,
        transactionId,
        verification: verificationMode,
        investorProfile: fundingState.investors.get(contributorAccountId) || null
      });

      await submitMessageToHCS({
        message_id: `msg-fund-contrib-${Date.now()}`,
        agent_id: 'fundraising-marketplace-001',
        agent_type: 'FUNDRAISING',
        action_type: 'CONTRIBUTION_RECORDED',
        experiment_id: campaign.experimentId,
        payload: {
          campaign_id: campaign.id,
          contributor_account_id: contributorAccountId,
          amount_usd: contribution.amountUsd,
          amount_hbar: contribution.amountHbar,
          transaction_id: transactionId || null,
          verification: verificationMode
        }
      });

      if (getFundingConfig().autoReleaseEnabled) {
        updateCampaignStatus(campaign);
      }
      markDatabaseDirty();

      res.json({
        contribution,
        verification: mirrorVerification,
        campaign: serializeCampaign(campaign)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/fundraising/campaigns/:campaignId/release', async (req, res) => {
    const campaign = fundingState.campaigns.get(req.params.campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { recipientAccountId, notes } = req.body || {};
    if (!recipientAccountId) {
      return res.status(400).json({ error: 'recipientAccountId is required' });
    }
    if (campaign.released) {
      return res.status(400).json({ error: 'Campaign funds already released' });
    }

    campaign.released = true;
    campaign.releaseHistory.unshift({
      recipientAccountId,
      notes: notes ? String(notes) : '',
      releasedAt: new Date().toISOString(),
      amountUsd: campaign.raisedUsd,
      amountTinybar: campaign.raisedTinybar
    });
    updateCampaignStatus(campaign);
    markDatabaseDirty();

    await submitMessageToHCS({
      message_id: `msg-fund-release-${Date.now()}`,
      agent_id: 'fundraising-marketplace-001',
      agent_type: 'FUNDRAISING',
      action_type: 'TREASURY_RELEASED',
      experiment_id: campaign.experimentId,
      payload: {
        campaign_id: campaign.id,
        recipient_account_id: recipientAccountId,
        amount_usd: campaign.raisedUsd,
        amount_hbar: fromTinybarToHbar(campaign.raisedTinybar),
        notes: notes ? String(notes) : ''
      }
    });

    res.json({
      released: true,
      campaign: serializeCampaign(campaign),
      warning: 'Treasury release is currently recorded as an on-platform release event. To move funds on-chain, send the corresponding HBAR/HTS transfer from the configured treasury wallet.'
    });
  });
}

module.exports = {
  registerFundingRoutes
};
