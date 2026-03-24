#  ALCHEMY Protocol
### Autonomous Scientific Research Protocol on Hedera / HOL Hashgraph

> A multi-agent system that identifies research gaps, designs experiments, pools capital from investors, hires human/AI labor, runs trials, and publishes verifiably reproducible results — all autonomously.

---

## Architecture

```
Hypothesis Agent → Peer Review Agent → Fundraising Agent
       ↓                   ↓                  ↓
                   HCS-10 Message Bus
       ↓                   ↓                  ↓
Labor Market Agent → Results Agent → Replication Agent
                            ↓
                     HOL Registry
                  (Agent Identity + Reputation)
```

**6 Agents, all powered by Mistral AI:**
1. **Hypothesis Agent** — Scans literature, generates testable hypotheses
2. **Peer Review Agent** — 5-reviewer council that attacks falsifiability
3. **Fundraising Agent** — Opens HTS capital pool, evaluates investor decisions
4. **Labor Market Agent** — Posts XMTP bounties, assigns EXP_TOKEN via HTS
5. **Results Agent** — Archives to HCS, pins to IPFS via Pinata, mints verifiable publication NFT
6. **Replication Agent** — Independently verifies, scores publication NFT reputation on-chain

**New Interactive Feature:**
* **Full-Screen Markdown Chat Popup:** Ask questions and interact with the AI logic in a beautifully styled, full-screen Markdown popup.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd alchemy-protocol
npm install
npm install @hashgraph/sdk
python -m pip install fastembed
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# ============================================================
# ALCHEMY PROTOCOL — Environment Configuration
# ============================================================
# Copy this file to .env and fill in your values

# -------------------------------------------------------
# REQUIRED: Mistral API Key
# Get yours at: https://console.mistral.ai/
# -------------------------------------------------------
MISTRAL_API_KEY=your_mistral_api_key_here

# -------------------------------------------------------
# OPTIONAL: Model selection (default: mistral-large-latest)
# Options: mistral-large-latest | mistral-medium-latest | mistral-small-latest
# mistral-large-latest  → best quality, higher cost
# mistral-medium-latest → good balance
# mistral-small-latest  → fastest, lowest cost
# -------------------------------------------------------
MODEL=mistral-large-latest

# -------------------------------------------------------
# OPTIONAL: Hypothesis Agent research stack
# -------------------------------------------------------
# Semantic Scholar API key is optional, but helps with rate limits
SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key_here
SEMANTIC_SCHOLAR_LIMIT=8

# Real BGE embedding reranker used for paper ranking
BGE_MODEL=BAAI/bge-small-en-v1.5

# Ollama fallback for any agent when Mistral is unavailable
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b

# -------------------------------------------------------
# OPTIONAL: HOL agent identity and discovery
# -------------------------------------------------------
AGENT_NAME=ALCHEMY Protocol Agent
AGENT_ALIAS=alchemy_protocol
AGENT_BIO=Autonomous scientific research agent with grounded literature retrieval, experiment orchestration, and Hedera-native logging.
AGENT_CREATOR=ALCHEMY Protocol
PUBLIC_APP_URL=http://localhost:3000
AUTO_REGISTER_AGENT=false
GUARDED_REGISTRY_BASE_URL=

# -------------------------------------------------------
# OPTIONAL: Hedera Testnet Credentials
# Needed for real on-chain HCS/HTS interactions
# Get a testnet account at: https://portal.hedera.com/
# -------------------------------------------------------
HEDERA_NETWORK=testnet
HEDERA_ACCOUNT_ID=your_hedera_account_id_here
HEDERA_PRIVATE_KEY=your_hedera_private_key_here
HCS_TOPIC_ID=0.0.XXXXXXX

# OPTIONAL: Reuse existing token IDs instead of auto-creating them
HTS_EXP_TOKEN_ID=0.0.XXXXXXX
HTS_PUBLICATION_TOKEN_ID=0.0.XXXXXXX

# OPTIONAL: Fundraising marketplace configuration
FUNDRAISING_TREASURY_ACCOUNT_ID=your_hedera_account_id_here
FUNDRAISING_ACCEPTED_ASSET=HBAR
FUNDRAISING_USD_PER_HBAR=0.10
FUNDRAISING_MIN_CONTRIBUTION_USD=25
FUNDRAISING_MATCHING_ENABLED=true
FUNDRAISING_MATCHING_CAP_USD=2500
FUNDRAISING_AUTO_RELEASE=false
HEDERA_MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com/api/v1

# OPTIONAL: labor marketplace + XMTP configuration
XMTP_ENABLED=false
XMTP_TOPIC=
LABOR_PAYOUT_ASSET=EXP
LABOR_PAYOUT_MULTIPLIER=1
LABOR_VERIFICATION_MODE=agent-review

# OPTIONAL: Token metadata
HTS_EXP_TOKEN_NAME=ALCHEMY EXP Token
HTS_EXP_TOKEN_SYMBOL=EXP
HTS_EXP_TOKEN_DECIMALS=0
HTS_PUBLICATION_TOKEN_NAME=ALCHEMY Publication NFT
HTS_PUBLICATION_TOKEN_SYMBOL=ALCHPUB

# -------------------------------------------------------
# OPTIONAL: HOL Registry Broker API Key
# Get yours at: https://hol.org/registry
# Needed for real agent registration on the HOL network
# -------------------------------------------------------
REGISTRY_BROKER_API_KEY=rbk_...

# -------------------------------------------------------
# Server Configuration
# -------------------------------------------------------
# OPTIONAL: XMTP A2A Messaging
# -------------------------------------------------------
XMTP_ENABLED=false
XMTP_PRIVATE_KEY=your_xmtp_private_key_here
XMTP_NETWORK=dev

# -------------------------------------------------------
# OPTIONAL: IPFS Publication Storage (Pinata)
# -------------------------------------------------------
PINATA_API_KEY=your_pinata_api_key_here
PINATA_API_SECRET=your_pinata_api_secret_here

# -------------------------------------------------------
# Server Configuration
# -------------------------------------------------------
PORT=3000

```

### 3. Start the Server

```bash
npm start
```

### 4. Open the App

Visit: [http://localhost:3000](http://localhost:3000)

---

## 🔑 What You Must Configure Manually

| Variable | Required | Where to Get It |
|----------|----------|----------------|
| `MISTRAL_API_KEY` | ✅ **REQUIRED** | [console.mistral.ai](https://console.mistral.ai/) |
| `BGE_MODEL` | ⚠️ Optional | BGE model for paper reranking, default `BAAI/bge-small-en-v1.5` |
| `HCS_TOPIC_ID` | ✅ **REQUIRED** | A Hedera Consensus Service topic you control |
| `HEDERA_ACCOUNT_ID` | ✅ **REQUIRED** | [portal.hedera.com](https://portal.hedera.com/) — free testnet account |
| `HEDERA_PRIVATE_KEY` | ✅ **REQUIRED** | Same as above — your testnet private key |
| `REGISTRY_BROKER_API_KEY`| ✅ **REQUIRED** | [hol.org/registry](https://hol.org/registry) |
| `PINATA_API_KEY` | ✅ **REQUIRED** | [pinata.cloud](https://pinata.cloud/) |
| `PINATA_API_SECRET`| ✅ **REQUIRED** | Same as above |
| `XMTP_PRIVATE_KEY` | ✅ **REQUIRED** | Standard EVM Wallet Private Key |

> **IMPORTANT: Simulation mode has been disabled.** This project requires full real-world credentials configured to execute successfully without crashing. Ensure your Hedera credentials have an active testnet HBAR balance!

**Model options** (set in `server.js` line 4):
- `mistral-large-latest` — best quality, higher cost (default)
- `mistral-medium-latest` — good balance
- `mistral-small-latest` — fastest, lowest cost

---

## 📁 File Structure

```
alchemy-protocol/
├── server.js              # Express server (API proxy + HCS/HOL simulation)
├── package.json           # Node.js dependencies
├── .env.example           # Environment variables template → copy to .env
├── .env                   # Your actual env vars (create this, never commit it)
├── public/
│   ├── index.html         # Main UI — the visual dashboard
│   ├── agents.js          # All 6 agent system prompts + configurations
│   └── app.js             # Pipeline orchestration + UI logic
└── README.md              # This file
```

---

## 🔬 How the Pipeline Works

When you click **"Run Experiment"**:

1. **Hypothesis Agent** receives your research topic → queries Semantic Scholar for real papers → reranks them with BGE embeddings → sends the grounded context to Mistral, or Ollama if Mistral fails → outputs structured JSON with gaps + hypotheses

2. **Peer Review Agent** receives the first hypothesis → simulates 5 independent reviewers (Validity, Testability, Novelty, Feasibility, Impact) → outputs review scores and ACCEPT/REVISE/REJECT decision

3. **Fundraising Agent** receives the hypothesis + review → estimates costs, simulates 3 investor types (Conservative, Balanced, Aggressive) → outputs funding decision + investor contributions

4. **Labor Market Agent** receives funded hypothesis → decomposes into 5-7 tasks → assigns EXP_TOKEN bounties → simulates AI/Human worker execution → logs to HCS

5. **Results Agent** collects task outputs → validates metrics → checks hypothesis consistency → distributes HTS rewards → mints publication NFT → publishes to HCS

6. **Replication Agent** independently re-executes → compares original vs replicated metrics → assigns trust score → updates NFT reputation → logs immutable verification to HCS

---

## 🌐 Hedera & Decentralized Integration

### Simulation Completely Disabled
The application has transitioned out of its "simulated MVP" phase. The following decentralized services are strictly enforced:
- **HCS-10 message bus**: Real events published natively to the Hedera Testnet.
- **HOL Registry Broker updates**: Real agent identities pushed up to the HOL ecosystem.
- **HTS token distribution**: Real $EXP token minting.
- **Publication NFT**: Real Hedera Non-Fungible Tokens generated, with metadata pinned securely to **IPFS via Pinata**.
- **XMTP Bounties**: Messages directly sent to the XMTP network.

Any execution without properly configured `.env` dependencies will "fail fast" and correctly abort instead of falling back to mocked output.

### How to Make It Real

To connect to **real Hedera testnet**:

1. Get a Hedera testnet account at [portal.hedera.com](https://portal.hedera.com/)
2. Add credentials to `.env`
3. Install the Hedera SDK: `npm install @hashgraph/sdk`
4. Set `HCS_TOPIC_ID` in `.env`
5. Start the server and inspect `GET /api/health` or `GET /api/hts/status` to confirm HCS/HTS are enabled
6. Use `@hashgraphonline/standards-sdk` for HOL registry:
   ```bash
   npm install @hashgraphonline/standards-sdk
   ```
7. Modify `server.js` further if you want custom transfer logic to real worker accounts

### Real HCS-10 Message Example
```javascript
const { Client, TopicMessageSubmitTransaction } = require('@hashgraph/sdk');
const client = Client.forTestnet();
client.setOperator(process.env.HEDERA_ACCOUNT_ID, process.env.HEDERA_PRIVATE_KEY);

await new TopicMessageSubmitTransaction({
  topicId: "0.0.XXXXX", // your HCS topic
  message: JSON.stringify(hcsMessage)
}).execute(client);
```

### Real HOL Registry Registration
```javascript
const { RegistryBrokerClient } = require('@hashgraphonline/standards-sdk');
const client = new RegistryBrokerClient({
  apiKey: process.env.REGISTRY_BROKER_API_KEY
});
await client.registerAgent(agentPayload);
```

---

## 🛠 Development

```bash
# Install dev dependencies for auto-reload
npm install -D nodemon

# Run in dev mode (auto-restarts on file changes)
npm run dev
```

---

## 📡 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Check server + API key status |
| `GET` | `/api/research/health` | Verify Semantic Scholar + BGE research stack |
| `POST` | `/api/research/papers` | Retrieve and rerank papers for a topic |
| `POST` | `/api/agent` | Run any agent (proxies to Claude) |
| `POST` | `/api/hcs/log` | Log an HCS-10 message |
| `GET` | `/api/hcs/log` | Get recent HCS messages |
| `DELETE` | `/api/hcs/log` | Clear HCS log |
| `GET` | `/api/hts/status` | Check Hedera HCS/HTS integration status and token IDs |
| `POST` | `/api/hol/update` | Update HOL registry for an agent |
| `GET` | `/api/hol/registry` | Get full HOL registry state |
| `DELETE` | `/api/hol/registry` | Clear HOL registry |

---

## 🎯 Current Implementation

The current implementation covers:
- ✅ Full 6-agent pipeline with Mistral AI integration
- ✅ Interactive Full-Screen Markdown Agent Chat interface
- ✅ Hypothesis agent with real Semantic Scholar retrieval and BGE reranking
- ✅ **Real On-Chain** HCS-10 message bus
- ✅ **Real On-Chain** HOL Registry TLS integration via the Broker API
- ✅ **Real On-Chain** HTS token generation for EXP rewards
- ✅ **Real Decentralized** Publication NFT metadata generation pinned via Pinata IPFS
- ✅ **Real Network** XMTP integration for open labor bidding
- ✅ Replication verification with HTS metadata reputation updating
- ✅ Beautiful dark sci-fi UI matching the ALCHEMY diagram
