const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

const {
  projectRoot,
  BGE_MODEL,
  SEMANTIC_SCHOLAR_API,
  DEFAULT_PAPER_LIMIT,
  PEER_REVIEW_PAPER_LIMIT,
  PEER_REVIEW_RETRIEVAL_COUNT,
  researchCache,
  hasConfiguredValue
} = require('../core/runtime');

const SEMANTIC_SCHOLAR_MIN_INTERVAL_MS = 1000;
let semanticScholarQueue = Promise.resolve();
let lastSemanticScholarRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWithSemanticScholarRateLimit(task) {
  const scheduled = semanticScholarQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, lastSemanticScholarRequestAt + SEMANTIC_SCHOLAR_MIN_INTERVAL_MS - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastSemanticScholarRequestAt = Date.now();
    return task();
  });

  semanticScholarQueue = scheduled.catch(() => {});
  return scheduled;
}

function normalizePaper(paper) {
  return {
    paperId: paper.paperId,
    title: paper.title || 'Untitled',
    abstract: paper.abstract || 'Abstract unavailable.',
    year: paper.year || null,
    venue: paper.venue || null,
    citationCount: paper.citationCount || 0,
    influentialCitationCount: paper.influentialCitationCount || 0,
    authors: (paper.authors || []).map((author) => author.name).filter(Boolean),
    url: paper.url || null,
    openAccessPdf: paper.openAccessPdf?.url || null,
    externalIds: paper.externalIds || {},
    fieldsOfStudy: paper.fieldsOfStudy || [],
    tldr: paper.tldr?.text || null
  };
}

function buildPaperDocument(paper) {
  return [
    paper.title,
    paper.abstract,
    paper.tldr ? `TLDR: ${paper.tldr}` : '',
    paper.venue ? `Venue: ${paper.venue}` : '',
    paper.year ? `Year: ${paper.year}` : '',
    paper.fieldsOfStudy?.length ? `Fields: ${paper.fieldsOfStudy.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function summarizeHypothesis(hypothesis) {
  if (!hypothesis) {
    return 'Unknown hypothesis';
  }

  if (typeof hypothesis === 'string') {
    return hypothesis;
  }

  const fields = [
    hypothesis.statement,
    hypothesis.expected_outcome,
    hypothesis.experimental_setup,
    hypothesis.evaluation_metric
  ].filter(Boolean);

  return fields.join(' | ') || JSON.stringify(hypothesis);
}

async function fetchSemanticScholarPapers(topic, limit = DEFAULT_PAPER_LIMIT) {
  const cacheKey = `${topic.toLowerCase()}::${limit}`;
  const cached = researchCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const url = new URL(`${SEMANTIC_SCHOLAR_API}/paper/search`);
  url.searchParams.set('query', topic);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', [
    'paperId',
    'title',
    'abstract',
    'year',
    'venue',
    'citationCount',
    'influentialCitationCount',
    'authors',
    'url',
    'openAccessPdf',
    'externalIds',
    'fieldsOfStudy',
    'tldr'
  ].join(','));

  const headers = {};
  if (hasConfiguredValue(process.env.SEMANTIC_SCHOLAR_API_KEY, ['your_semantic_scholar_api_key_here'])) {
    headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  const response = await runWithSemanticScholarRateLimit(() => fetch(url.toString(), { headers }));
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Semantic Scholar rate limit hit (HTTP 429). The app now throttles to 1 request/second, but an API key is still recommended for reliability.');
    }
    throw new Error(`Semantic Scholar search failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  const normalized = (data.data || []).map(normalizePaper);
  researchCache.set(cacheKey, normalized);
  return normalized;
}

function rerankPapersWithBge(query, papers) {
  return new Promise((resolve, reject) => {
    const documents = papers.map((paper) => buildPaperDocument(paper));
    const scriptPath = path.join(projectRoot, 'scripts', 'bge_ranker.py');
    const child = spawn('python', [scriptPath], {
      cwd: projectRoot,
      env: { ...process.env, BGE_MODEL }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `BGE reranker exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }

        const rankedPapers = parsed.ranked.map((item) => ({
          ...papers[item.index],
          relevanceScore: Number(item.score.toFixed(6))
        }));

        resolve({
          model: parsed.model,
          papers: rankedPapers
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(JSON.stringify({
      query,
      documents,
      model_name: BGE_MODEL
    }));
    child.stdin.end();
  });
}

function formatPaperForPrompt(paper, index) {
  const lines = [
    `[Paper ${index + 1}] ${paper.title}`,
    paper.year ? `Year: ${paper.year}` : null,
    paper.venue ? `Venue: ${paper.venue}` : null,
    `Relevance: ${paper.relevanceScore ?? 'n/a'}`,
    `Citations: ${paper.citationCount || 0}`,
    `Authors: ${(paper.authors || []).slice(0, 6).join(', ') || 'Unknown'}`,
    `Abstract: ${paper.abstract || 'Abstract unavailable.'}`
  ].filter(Boolean);

  return lines.join('\n');
}

function buildHypothesisUserMessage(topic, basePrompt, researchContext) {
  const papersBlock = researchContext.papers.map(formatPaperForPrompt).join('\n\n');
  const evidenceBlock = researchContext.papers.length
    ? papersBlock
    : 'No external papers were available for this run. Use domain knowledge carefully, state uncertainty explicitly, and avoid claiming literature-backed support.';
  return [
    `Research topic: "${topic}"`,
    '',
    researchContext.papers.length
      ? 'Use the following retrieved Semantic Scholar papers ranked with BGE embeddings as your primary evidence base.'
      : 'Semantic Scholar evidence was unavailable for this run. Proceed without retrieved papers and clearly mark unsupported claims as uncertain.',
    `Semantic Scholar results fetched: ${researchContext.totalFetched}`,
    `BGE model: ${researchContext.embeddingModel}`,
    '',
    evidenceBlock,
    '',
    'Instructions:',
    '- If no papers are available, say so explicitly in the JSON fields.',
    '- If papers are available, ground gaps and hypotheses in those papers only.',
    '- If evidence is thin or contradictory, say so explicitly in the JSON fields.',
    '- Prefer recent papers and note contradictions or missing baselines.',
    '',
    basePrompt
  ].join('\n');
}

async function buildHypothesisResearchContext(topic) {
  try {
    const papers = await fetchSemanticScholarPapers(topic);
    if (!papers.length) {
      throw new Error('Semantic Scholar returned no papers for this topic');
    }

    const reranked = await rerankPapersWithBge(topic, papers);
    return {
      provider: 'Semantic Scholar',
      embeddingModel: reranked.model,
      totalFetched: papers.length,
      papers: reranked.papers.slice(0, 5),
      degraded: false,
      warning: null
    };
  } catch (err) {
    return {
      provider: 'Semantic Scholar (fallback)',
      embeddingModel: BGE_MODEL,
      totalFetched: 0,
      papers: [],
      degraded: true,
      warning: err.message
    };
  }
}

function buildPeerReviewQuery(hypothesis) {
  if (!hypothesis) {
    return '';
  }

  if (typeof hypothesis === 'string') {
    return hypothesis;
  }

  return [
    hypothesis.statement,
    hypothesis.independent_variable ? `independent variable ${hypothesis.independent_variable}` : '',
    hypothesis.dependent_variable ? `dependent variable ${hypothesis.dependent_variable}` : '',
    hypothesis.experimental_setup ? `setup ${hypothesis.experimental_setup}` : '',
    hypothesis.evaluation_metric ? `metric ${hypothesis.evaluation_metric}` : ''
  ].filter(Boolean).join(' ');
}

async function buildPeerReviewResearchContext(hypothesis) {
  const query = buildPeerReviewQuery(hypothesis);
  try {
    const papers = await fetchSemanticScholarPapers(query, PEER_REVIEW_PAPER_LIMIT);
    if (!papers.length) {
      throw new Error('Semantic Scholar returned no papers for peer review');
    }

    const reranked = await rerankPapersWithBge(query, papers);
    return {
      provider: 'Semantic Scholar',
      embeddingModel: reranked.model,
      totalFetched: papers.length,
      papers: reranked.papers.slice(0, PEER_REVIEW_RETRIEVAL_COUNT),
      query,
      degraded: false,
      warning: null
    };
  } catch (err) {
    return {
      provider: 'Semantic Scholar (fallback)',
      embeddingModel: BGE_MODEL,
      totalFetched: 0,
      papers: [],
      query,
      degraded: true,
      warning: err.message
    };
  }
}

function buildPeerReviewReviewerPrompt(reviewer, hypothesis, researchContext) {
  const papersBlock = researchContext.papers.map(formatPaperForPrompt).join('\n\n');
  const evidenceBlock = researchContext.papers.length
    ? papersBlock
    : 'No retrieved papers were available. Review conservatively, flag missing evidence, and do not invent literature support.';
  return [
    `Reviewer identity: ${reviewer.identity}`,
    `Reviewer role: ${reviewer.title}`,
    `Primary focus: ${reviewer.focus}`,
    '',
    'Hypothesis to review:',
    JSON.stringify(hypothesis, null, 2),
    '',
    researchContext.papers.length
      ? 'Retrieved papers from Semantic Scholar ranked with BGE embeddings:'
      : 'Retrieved papers were unavailable for this review:',
    `Search query: ${researchContext.query}`,
    `Papers fetched: ${researchContext.totalFetched}`,
    `Embedding model: ${researchContext.embeddingModel}`,
    '',
    evidenceBlock,
    '',
    'Instructions:',
    '- Review only from the perspective assigned to you.',
    '- Ground the review in the retrieved papers when available and explicitly mention evidence gaps when literature is insufficient.',
    '- If no papers are available, say that the review is based on the hypothesis text alone and lower confidence accordingly.',
    '- Score on a 1-10 scale.',
    '- Keep issues and strengths concise.',
    '- Output ONLY valid JSON with this exact schema:',
    '{"score":0,"issues":[],"strengths":[],"verdict":"","evidence_summary":"","confidence":"low | medium | high"}'
  ].join('\n');
}

module.exports = {
  normalizePaper,
  buildPaperDocument,
  summarizeHypothesis,
  fetchSemanticScholarPapers,
  rerankPapersWithBge,
  formatPaperForPrompt,
  buildHypothesisUserMessage,
  buildHypothesisResearchContext,
  buildPeerReviewQuery,
  buildPeerReviewResearchContext,
  buildPeerReviewReviewerPrompt
};
