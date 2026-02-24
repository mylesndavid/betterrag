// LLM enrichment via OpenRouter + Gemini Flash

import { saveGraph } from './cache.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.0-flash-lite-001';

const SYSTEM_PROMPT = `You are analyzing a conversation cluster from a chat/email graph. Return JSON only, no markdown fences.
{
  "summary": "1-2 sentence summary of what was discussed",
  "decisions": ["any decisions or action items mentioned"],
  "topics": ["key topics, max 5"],
  "sentiment": "one of: productive, casual, urgent, tense, informational",
  "relationships": [
    { "from": "node name", "to": "node name", "edge": "ANY_RELATIONSHIP_TYPE", "detail": "short description" }
  ]
}

For relationships, express any relationship you see. The edge type is freeform — use whatever best describes the relationship (MANAGES, BLOCKED_BY, ESCALATED_TO, DEPENDS_ON, FRUSTRATED_WITH, OWNS, WORKS_ON, ASKED_ABOUT, etc). Only include relationships you're confident about.`;

/**
 * Call OpenRouter with a prompt, return parsed JSON response
 */
async function callLLM(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable required');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/betterrag',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 512,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Parse JSON — strip markdown fences if present
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Enrich a single cluster node with LLM analysis.
 * Returns the enrichment result object.
 */
export async function enrichCluster(rawText, participants) {
  const userPrompt = `Participants: ${participants.join(', ')}\n\nConversation:\n${rawText.slice(0, 4000)}`;

  const result = await callLLM([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]);

  // Normalize
  return {
    summary: result.summary || '',
    decisions: Array.isArray(result.decisions) ? result.decisions : [],
    topics: Array.isArray(result.topics) ? result.topics : [],
    sentiment: result.sentiment || 'informational',
    relationships: Array.isArray(result.relationships) ? result.relationships : [],
  };
}

/**
 * Apply enrichment results to the graph — creates semantic nodes and edges.
 */
export function applyEnrichment(graph, clusterId, enrichment) {
  const attrs = graph.getNodeAttributes(clusterId);

  // Store enrichment as annotation
  attrs.annotations.push({
    type: 'enrichment',
    by: 'gemini-flash',
    summary: enrichment.summary,
    decisions: enrichment.decisions,
    topics: enrichment.topics,
    sentiment: enrichment.sentiment,
    at: Date.now(),
  });

  // Create topic entity nodes + ABOUT edges
  for (const topic of enrichment.topics) {
    const entityId = resolveOrCreateEntity(graph, topic, 'semantic');
    graph.addEdge(clusterId, entityId, { type: 'ABOUT', weight: 1, by: 'enrichment' });
  }

  // Create decision entity nodes + DECIDED edges
  for (const decision of enrichment.decisions) {
    const entityId = resolveOrCreateEntity(graph, decision, 'decision');
    graph.addEdge(clusterId, entityId, { type: 'DECIDED', weight: 1, by: 'enrichment' });
  }

  // Create relationship edges — resolve from/to to existing nodes
  for (const rel of enrichment.relationships) {
    if (!rel.from || !rel.to || !rel.edge) continue;
    const fromId = resolveNode(graph, rel.from);
    const toId = resolveNode(graph, rel.to) || resolveOrCreateEntity(graph, rel.to, 'semantic');
    if (fromId && toId) {
      graph.addEdge(fromId, toId, {
        type: rel.edge,
        weight: 1,
        detail: rel.detail || '',
        by: 'enrichment',
      });
    }
  }
}

/**
 * Fuzzy-match a name to an existing node (person or entity).
 */
function resolveNode(graph, name) {
  const lower = name.toLowerCase().trim();

  // Try exact person match
  const personId = `person:${name}`;
  if (graph.hasNode(personId)) return personId;

  // Try exact entity match
  const entityId = `entity:${lower}`;
  if (graph.hasNode(entityId)) return entityId;

  // Fuzzy: case-insensitive scan of people
  let match = null;
  graph.forEachNode((id, attrs) => {
    if (match) return;
    if (attrs.type === 'person' && attrs.name.toLowerCase() === lower) {
      match = id;
    }
  });
  if (match) return match;

  // Fuzzy: check entity names
  graph.forEachNode((id, attrs) => {
    if (match) return;
    if (attrs.type === 'entity' && attrs.name.toLowerCase() === lower) {
      match = id;
    }
  });

  return match;
}

/**
 * Find existing entity or create new semantic entity node.
 */
function resolveOrCreateEntity(graph, name, entityType) {
  const lower = name.toLowerCase().trim();
  const entityId = `entity:${lower}`;

  if (graph.hasNode(entityId)) return entityId;

  // Check if entity exists with different casing
  let existing = null;
  graph.forEachNode((id, attrs) => {
    if (existing) return;
    if (attrs.type === 'entity' && attrs.name.toLowerCase() === lower) {
      existing = id;
    }
  });
  if (existing) return existing;

  // Create new
  graph.addNode(entityId, {
    type: 'entity',
    name: lower,
    entityType,
    globalFrequency: 0,
    visit_count: 0,
    last_visited: null,
    annotations: [],
  });

  return entityId;
}

/**
 * Check if a cluster has already been enriched.
 */
export function isEnriched(graph, clusterId) {
  const attrs = graph.getNodeAttributes(clusterId);
  return attrs.annotations?.some(a => a.type === 'enrichment') || false;
}

/**
 * Get enrichment annotation from a cluster node.
 */
export function getEnrichment(graph, clusterId) {
  const attrs = graph.getNodeAttributes(clusterId);
  return attrs.annotations?.find(a => a.type === 'enrichment') || null;
}

/**
 * Batch enrich clusters in the graph.
 * @param {Graph} graph
 * @param {object} opts - { limit, force, onProgress }
 * @returns {Promise<{ enriched: number, errors: number }>}
 */
export async function batchEnrich(graph, opts = {}) {
  const { limit = 50, force = false, onProgress } = opts;

  // Find clusters to enrich
  const clusters = [];
  graph.forEachNode((id, attrs) => {
    if (attrs.type !== 'cluster') return;
    if (!force && isEnriched(graph, id)) return;
    if (!attrs.rawText || attrs.rawText.length < 20) return;
    clusters.push({ id, rawText: attrs.rawText, participants: attrs.participants || [] });
  });

  const toEnrich = clusters.slice(0, limit);
  let enriched = 0;
  let errors = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const c = toEnrich[i];
    try {
      const result = await enrichCluster(c.rawText, c.participants);
      applyEnrichment(graph, c.id, result);
      enriched++;
      if (onProgress) onProgress(i + 1, toEnrich.length, c.id, result.summary);
    } catch (err) {
      errors++;
      if (onProgress) onProgress(i + 1, toEnrich.length, c.id, `ERROR: ${err.message}`);
    }

    // Rate limit: 1 req/sec
    if (i < toEnrich.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { enriched, errors, total: toEnrich.length };
}
