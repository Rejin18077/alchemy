const fetch = require('node-fetch');

const {
  MISTRAL_API_KEY,
  MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  hasConfiguredValue
} = require('../core/runtime');

async function callMistral(systemPrompt, userMessage, maxTokens) {
  if (!hasConfiguredValue(MISTRAL_API_KEY, ['your_mistral_api_key_here'])) {
    throw new Error('MISTRAL_API_KEY not set in .env file');
  }

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || `Mistral request failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: 'mistral',
    model: MODEL,
    raw: data.choices?.[0]?.message?.content || '',
    usage: data.usage || null
  };
}

async function callOllama(systemPrompt, userMessage) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || `Ollama request failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: 'ollama',
    model: OLLAMA_MODEL,
    raw: data.message?.content || ''
  };
}

function tryParseModelJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return null;
  }
}

async function runAgentModelChain({ agentKey, systemPrompt, userMessage, maxTokens }) {
  const errors = [];

  try {
    return await callMistral(systemPrompt, userMessage, maxTokens);
  } catch (err) {
    errors.push(`Mistral: ${err.message}`);
  }

  try {
    const ollamaResult = await callOllama(systemPrompt, userMessage);
    return {
      ...ollamaResult,
      fallbackReason: errors[0] || 'Mistral unavailable'
    };
  } catch (err) {
    errors.push(`Ollama: ${err.message}`);
  }

  throw new Error(`${agentKey} failed across providers. ${errors.join(' | ')}`);
}

module.exports = {
  callMistral,
  callOllama,
  tryParseModelJson,
  runAgentModelChain
};
