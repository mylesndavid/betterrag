// Graph building, PageRank, queries

import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import { extractEntities, computeIDF, scoreTFIDF } from './tokenizer.js';

/**
 * Build a conversation graph from clustered data.
 * Returns a graphology Graph instance with all node/edge types.
 */
export function buildGraph(clusters, channels, people) {
  const graph = new Graph({ multi: true, type: 'mixed' });

  // Add person nodes
  for (const person of people) {
    const id = `person:${person.name}`;
    if (!graph.hasNode(id)) {
      graph.addNode(id, {
        type: 'person',
        name: person.name,
        aliases: person.aliases || [],
        visit_count: 0,
        last_visited: null,
        annotations: [],
      });
    }
  }

  // Add channel nodes
  for (const ch of channels) {
    const id = `channel:${ch.name}`;
    if (!graph.hasNode(id)) {
      graph.addNode(id, {
        type: 'channel',
        name: ch.name,
        channelType: ch.type,
        visit_count: 0,
        last_visited: null,
        annotations: [],
      });
    }
  }

  // Build person name set for entity filtering
  const personNames = new Set(people.map(p => p.name.toLowerCase()));

  // Extract entities for all clusters, then compute IDF
  const clusterEntitiesList = clusters.map(c => extractEntities(c.messages, personNames));
  const idf = computeIDF(clusterEntitiesList);

  // Track person-channel message counts and person-person interactions
  const personChannelCounts = new Map();
  const personInteractions = new Map();

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const entities = scoreTFIDF(clusterEntitiesList[i], idf);
    const topEntities = entities.filter(e => e.frequency >= 2).slice(0, 15); // min freq 2, top 15

    // Add cluster node
    graph.addNode(cluster.id, {
      type: 'cluster',
      channel: cluster.channel,
      startTime: cluster.startTime,
      endTime: cluster.endTime,
      participantCount: cluster.participantCount,
      messageCount: cluster.messageCount,
      participants: cluster.participants,
      threadId: cluster.threadId || null,
      rawText: cluster.messages.filter(m => !m._participantOnly).map(m => `${m.sender}: ${m.text}`).join('\n'),
      visit_count: 0,
      last_visited: null,
      annotations: [],
    });

    // CONTAINS: channel → cluster
    const chId = `channel:${cluster.channel}`;
    if (graph.hasNode(chId)) {
      graph.addEdge(chId, cluster.id, { type: 'CONTAINS', weight: 1 });
    }

    // Per-participant edges (participant-only entries get weight 1 for presence)
    const participantMsgCounts = new Map();
    for (const msg of cluster.messages) {
      const w = msg._participantOnly ? 0 : 1;
      participantMsgCounts.set(msg.sender, (participantMsgCounts.get(msg.sender) || 0) + w);
    }
    // Ensure participant-only people still get at least weight 1
    for (const [sender, count] of participantMsgCounts) {
      if (count === 0) participantMsgCounts.set(sender, 1);
    }

    for (const [sender, count] of participantMsgCounts) {
      const pId = `person:${sender}`;
      if (!graph.hasNode(pId)) {
        graph.addNode(pId, {
          type: 'person', name: sender, aliases: [],
          visit_count: 0, last_visited: null, annotations: [],
        });
      }

      // SENT_IN: person → cluster
      graph.addEdge(pId, cluster.id, { type: 'SENT_IN', weight: count });

      // Track person-channel counts
      const pcKey = `${sender}|${cluster.channel}`;
      personChannelCounts.set(pcKey, (personChannelCounts.get(pcKey) || 0) + count);
    }

    // INTERACTS: person ↔ person (same cluster)
    const participants = [...participantMsgCounts.keys()];
    for (let a = 0; a < participants.length; a++) {
      for (let b = a + 1; b < participants.length; b++) {
        const key = [participants[a], participants[b]].sort().join('|');
        const weight = Math.min(participantMsgCounts.get(participants[a]), participantMsgCounts.get(participants[b]));
        personInteractions.set(key, (personInteractions.get(key) || 0) + weight);
      }
    }

    // Add entity nodes and MENTIONS edges
    for (const ent of topEntities) {
      const eId = `entity:${ent.name}`;
      if (!graph.hasNode(eId)) {
        graph.addNode(eId, {
          type: 'entity',
          name: ent.name,
          entityType: ent.type,
          globalFrequency: 0,
          visit_count: 0,
          last_visited: null,
          annotations: [],
        });
      }
      const attrs = graph.getNodeAttributes(eId);
      attrs.globalFrequency += ent.frequency;

      graph.addEdge(cluster.id, eId, { type: 'MENTIONS', weight: ent.tfidf || ent.frequency });
    }

    // CO_OCCURS: entity ↔ entity in same cluster
    for (let a = 0; a < topEntities.length && a < 10; a++) {
      for (let b = a + 1; b < topEntities.length && b < 10; b++) {
        const eA = `entity:${topEntities[a].name}`;
        const eB = `entity:${topEntities[b].name}`;
        graph.addEdge(eA, eB, {
          type: 'CO_OCCURS',
          weight: Math.min(topEntities[a].frequency, topEntities[b].frequency),
        });
      }
    }
  }

  // Add aggregated PARTICIPATES edges: person → channel
  for (const [key, count] of personChannelCounts) {
    const [sender, channel] = key.split('|');
    const pId = `person:${sender}`;
    const chId = `channel:${channel}`;
    if (graph.hasNode(pId) && graph.hasNode(chId)) {
      graph.addEdge(pId, chId, { type: 'PARTICIPATES', weight: count });
    }
  }

  // Add aggregated INTERACTS edges
  for (const [key, weight] of personInteractions) {
    const [a, b] = key.split('|');
    graph.addEdge(`person:${a}`, `person:${b}`, { type: 'INTERACTS', weight });
  }

  return graph;
}

/**
 * Run PageRank and store scores as node attributes
 */
export function computePageRank(graph) {
  const scores = pagerank(graph, { getEdgeWeight: 'weight' });
  for (const [node, score] of Object.entries(scores)) {
    graph.setNodeAttribute(node, 'pagerank', score);
  }
  return scores;
}

/**
 * Search nodes by text match against name/rawText
 */
export function searchNodes(graph, query) {
  const q = query.toLowerCase();
  const results = [];

  graph.forEachNode((node, attrs) => {
    let score = 0;
    const name = (attrs.name || '').toLowerCase();
    const rawText = (attrs.rawText || '').toLowerCase();

    if (name === q) score = 10;
    else if (name.includes(q)) score = 5;
    if (rawText.includes(q)) score += 2;

    if (score > 0) {
      results.push({ id: node, ...attrs, searchScore: score });
    }
  });

  results.sort((a, b) => b.searchScore - a.searchScore);
  return results;
}

/**
 * BFS traversal from a node up to N hops
 */
export function traverse(graph, nodeId, hops = 2) {
  if (!graph.hasNode(nodeId)) return null;

  // Mark as visited
  const attrs = graph.getNodeAttributes(nodeId);
  attrs.visit_count = (attrs.visit_count || 0) + 1;
  attrs.last_visited = Date.now();

  const visited = new Set([nodeId]);
  const layers = [{ id: nodeId, ...attrs, depth: 0 }];
  let frontier = [nodeId];

  for (let depth = 1; depth <= hops; depth++) {
    const nextFrontier = [];
    for (const current of frontier) {
      graph.forEachNeighbor(current, (neighbor, neighborAttrs) => {
        if (visited.has(neighbor)) return;
        visited.add(neighbor);
        nextFrontier.push(neighbor);

        // Get edge info
        const edges = [];
        graph.forEachEdge(current, neighbor, (edge, edgeAttrs) => {
          edges.push({ id: edge, ...edgeAttrs });
        });

        layers.push({
          id: neighbor,
          ...neighborAttrs,
          depth,
          edgesFromParent: edges,
        });
      });
    }
    frontier = nextFrontier;
  }

  return layers;
}

/**
 * Get ranked list of nodes by type
 */
export function rankedByType(graph, type, limit = 20) {
  const nodes = [];
  graph.forEachNode((id, attrs) => {
    if (attrs.type === type) {
      nodes.push({ id, ...attrs });
    }
  });
  nodes.sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0));
  return nodes.slice(0, limit);
}

/**
 * Get person profile — topics, connections, activity
 */
export function personProfile(graph, name) {
  const nodeId = `person:${name}`;
  if (!graph.hasNode(nodeId)) {
    // Try case-insensitive search
    let found = null;
    graph.forEachNode((id, attrs) => {
      if (attrs.type === 'person' && attrs.name.toLowerCase() === name.toLowerCase()) {
        found = id;
      }
    });
    if (!found) return null;
    return personProfile(graph, graph.getNodeAttribute(found, 'name'));
  }

  const attrs = graph.getNodeAttributes(nodeId);
  attrs.visit_count = (attrs.visit_count || 0) + 1;
  attrs.last_visited = Date.now();

  // Channels they participate in
  const channels = [];
  const interactions = [];
  const clusterIds = [];
  const topicFreq = new Map();

  graph.forEachEdge(nodeId, (edge, edgeAttrs, source, target) => {
    const neighborId = source === nodeId ? target : source;
    const neighborAttrs = graph.getNodeAttributes(neighborId);

    if (edgeAttrs.type === 'PARTICIPATES') {
      channels.push({ name: neighborAttrs.name, messageCount: edgeAttrs.weight });
    } else if (edgeAttrs.type === 'INTERACTS') {
      interactions.push({ name: neighborAttrs.name, weight: edgeAttrs.weight });
    } else if (edgeAttrs.type === 'SENT_IN') {
      clusterIds.push(neighborId);
      // Get topics from cluster
      graph.forEachEdge(neighborId, (e2, e2Attrs, s2, t2) => {
        if (e2Attrs.type === 'MENTIONS') {
          const entityId = s2 === neighborId ? t2 : s2;
          const entityAttrs = graph.getNodeAttributes(entityId);
          topicFreq.set(entityAttrs.name, (topicFreq.get(entityAttrs.name) || 0) + (e2Attrs.weight || 1));
        }
      });
    }
  });

  const topics = [...topicFreq.entries()]
    .map(([name, weight]) => ({ name, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  channels.sort((a, b) => b.messageCount - a.messageCount);
  interactions.sort((a, b) => b.weight - a.weight);

  return {
    id: nodeId,
    name: attrs.name,
    pagerank: attrs.pagerank,
    channels,
    interactions: interactions.slice(0, 20),
    topics,
    clusterCount: clusterIds.length,
    annotations: attrs.annotations,
  };
}

/**
 * Add annotation to a node
 */
export function annotateNode(graph, nodeId, annotation) {
  if (!graph.hasNode(nodeId)) return false;
  const attrs = graph.getNodeAttributes(nodeId);
  attrs.annotations.push({
    ...annotation,
    at: Date.now(),
  });

  // If it's a semantic edge type (ABOUT, DECIDED, RELATES_TO), also add edge
  if (annotation.targetEntity) {
    const targetId = `entity:${annotation.targetEntity}`;
    if (!graph.hasNode(targetId)) {
      graph.addNode(targetId, {
        type: 'entity', name: annotation.targetEntity, entityType: 'annotated',
        globalFrequency: 0, visit_count: 0, last_visited: null, annotations: [],
      });
    }
    graph.addEdge(nodeId, targetId, {
      type: annotation.type || 'ABOUT',
      weight: 1,
      text: annotation.text,
      by: annotation.by,
    });
  }

  return true;
}

/**
 * Get most visited / annotated nodes
 */
export function hotNodes(graph, limit = 20) {
  const nodes = [];
  graph.forEachNode((id, attrs) => {
    const heat = (attrs.visit_count || 0) + (attrs.annotations?.length || 0) * 3;
    if (heat > 0) nodes.push({ id, ...attrs, heat });
  });
  nodes.sort((a, b) => b.heat - a.heat);
  return nodes.slice(0, limit);
}

/**
 * Post-process: merge plural/reversed entity duplicates across the whole graph
 */
export function deduplicateEntities(graph) {
  const entityMap = new Map(); // canonical name → node id
  const remaps = new Map(); // old id → canonical id

  // First pass: build canonical mapping
  graph.forEachNode((id, attrs) => {
    if (attrs.type !== 'entity') return;
    const name = attrs.name;
    // Check for plural forms
    let canonical = name;
    if (name.endsWith('s') && !name.endsWith('ss') && name.length > 3) {
      const base = name.slice(0, -1);
      const baseId = `entity:${base}`;
      if (graph.hasNode(baseId)) { canonical = base; }
    }
    if (name.endsWith('es') && name.length > 4) {
      const base = name.slice(0, -2);
      const baseId = `entity:${base}`;
      if (graph.hasNode(baseId)) { canonical = base; }
    }
    // Check for reversed bigrams
    const parts = name.split(' ');
    if (parts.length === 2) {
      const rev = `${parts[1]} ${parts[0]}`;
      const revId = `entity:${rev}`;
      if (graph.hasNode(revId) && !remaps.has(revId)) { canonical = rev; }
    }
    if (canonical !== name) {
      remaps.set(id, `entity:${canonical}`);
    }
  });

  // Second pass: merge edges and remove dupes
  let merged = 0;
  for (const [oldId, newId] of remaps) {
    if (!graph.hasNode(oldId) || !graph.hasNode(newId)) continue;
    // Merge frequency
    const oldAttrs = graph.getNodeAttributes(oldId);
    const newAttrs = graph.getNodeAttributes(newId);
    newAttrs.globalFrequency = (newAttrs.globalFrequency || 0) + (oldAttrs.globalFrequency || 0);
    // Move edges
    const edgesToMove = [];
    graph.forEachEdge(oldId, (e, attrs, src, tgt) => {
      edgesToMove.push({ attrs: { ...attrs }, src, tgt });
    });
    for (const { attrs, src, tgt } of edgesToMove) {
      const newSrc = src === oldId ? newId : src;
      const newTgt = tgt === oldId ? newId : tgt;
      if (newSrc !== newTgt && graph.hasNode(newSrc) && graph.hasNode(newTgt)) {
        graph.addEdge(newSrc, newTgt, attrs);
      }
    }
    graph.dropNode(oldId);
    merged++;
  }
  return merged;
}

/**
 * Merge a second graph's data into an existing graph.
 * Matches people by name similarity across sources.
 */
export function mergeGraphs(target, source) {
  // Build a name lookup for people in target graph
  const targetPeople = new Map(); // lowercase name/alias → node id
  target.forEachNode((id, attrs) => {
    if (attrs.type !== 'person') return;
    const name = attrs.name.toLowerCase();
    targetPeople.set(name, id);
    // Strip emoji/unicode for matching (e.g. "Manuel😎" → "manuel")
    const clean = name.replace(/[^a-z0-9\s'-]/g, '').trim();
    if (clean && clean !== name) targetPeople.set(clean, id);
    // First name match
    const first = clean.split(/\s+/)[0];
    if (first.length > 2 && !targetPeople.has(first)) {
      targetPeople.set(first, id);
    }
    for (const alias of (attrs.aliases || [])) {
      targetPeople.set(alias.toLowerCase(), id);
    }
  });

  // Map source node IDs → target node IDs (for remapping edges)
  const nodeMap = new Map();
  let added = { nodes: 0, edges: 0, merged: 0 };

  // Merge nodes
  source.forEachNode((id, attrs) => {
    if (attrs.type === 'person') {
      // Try to match to existing person
      const name = attrs.name.toLowerCase();
      const clean = name.replace(/[^a-z0-9\s'-]/g, '').trim();
      const first = clean.split(/\s+/)[0];
      // Also try matching the node ID directly
      const match = targetPeople.get(name) || targetPeople.get(clean) || targetPeople.get(first)
        || (target.hasNode(id) ? id : null);

      if (match) {
        nodeMap.set(id, match);
        added.merged++;
        // Merge aliases
        const targetAttrs = target.getNodeAttributes(match);
        for (const alias of (attrs.aliases || [])) {
          if (!targetAttrs.aliases.includes(alias)) targetAttrs.aliases.push(alias);
        }
      } else {
        // New person — add to target
        if (!target.hasNode(id)) {
          target.addNode(id, { ...attrs });
          added.nodes++;
        }
        nodeMap.set(id, id);
      }
    } else if (attrs.type === 'channel') {
      // Channels are always unique per source (different chat vs email threads)
      // Prefix with source to avoid collisions
      const newId = target.hasNode(id) ? `${id}_2` : id;
      if (!target.hasNode(newId)) {
        target.addNode(newId, { ...attrs });
        added.nodes++;
      }
      nodeMap.set(id, newId);
    } else {
      // Clusters and entities — check for entity dedup by name
      if (attrs.type === 'entity') {
        const existingId = `entity:${attrs.name}`;
        if (target.hasNode(existingId)) {
          // Merge frequency
          const existing = target.getNodeAttributes(existingId);
          existing.globalFrequency = (existing.globalFrequency || 0) + (attrs.globalFrequency || 0);
          nodeMap.set(id, existingId);
          return;
        }
      }
      const newId = target.hasNode(id) ? `${id}_2` : id;
      if (!target.hasNode(newId)) {
        target.addNode(newId, { ...attrs });
        added.nodes++;
      }
      nodeMap.set(id, newId);
    }
  });

  // Merge edges
  source.forEachEdge((edge, attrs, src, tgt) => {
    const mappedSrc = nodeMap.get(src);
    const mappedTgt = nodeMap.get(tgt);
    if (!mappedSrc || !mappedTgt) return;
    if (!target.hasNode(mappedSrc) || !target.hasNode(mappedTgt)) return;

    // For INTERACTS edges, try to find existing and add weight
    if (attrs.type === 'INTERACTS') {
      let found = false;
      target.forEachEdge(mappedSrc, mappedTgt, (e, eAttrs) => {
        if (eAttrs.type === 'INTERACTS') {
          eAttrs.weight = (eAttrs.weight || 0) + (attrs.weight || 0);
          found = true;
        }
      });
      if (!found) {
        target.addEdge(mappedSrc, mappedTgt, { ...attrs });
        added.edges++;
      }
    } else {
      target.addEdge(mappedSrc, mappedTgt, { ...attrs });
      added.edges++;
    }
  });

  return added;
}

/**
 * Get graph statistics
 */
export function graphStats(graph) {
  const typeCounts = {};
  graph.forEachNode((_, attrs) => {
    typeCounts[attrs.type] = (typeCounts[attrs.type] || 0) + 1;
  });

  const edgeTypeCounts = {};
  graph.forEachEdge((_, attrs) => {
    edgeTypeCounts[attrs.type] = (edgeTypeCounts[attrs.type] || 0) + 1;
  });

  return {
    nodes: graph.order,
    edges: graph.size,
    nodeTypes: typeCounts,
    edgeTypes: edgeTypeCounts,
  };
}
