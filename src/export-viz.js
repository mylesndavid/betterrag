// Export graph data for visualization
import { ConversationIndex } from './index.js';
import { writeFile } from 'node:fs/promises';

const idx = new ConversationIndex();
await idx.load();

const nodes = [];
const edges = [];
const topEntities = new Set();

// Get top 40 entities
const ents = [];
idx.graph.forEachNode((id, attrs) => {
  if (attrs.type === 'entity') ents.push({ id, freq: attrs.globalFrequency, name: attrs.name });
});
ents.sort((a, b) => b.freq - a.freq);
for (const e of ents.slice(0, 40)) topEntities.add(e.id);

// All people
idx.graph.forEachNode((id, attrs) => {
  if (attrs.type === 'person') {
    let clusterCount = 0;
    idx.graph.forEachEdge(id, (e, ea) => { if (ea.type === 'SENT_IN') clusterCount++; });
    nodes.push({ id, type: 'person', name: attrs.name, rank: attrs.pagerank || 0, clusters: clusterCount });
  }
});

// Top entities
for (const eid of topEntities) {
  const attrs = idx.graph.getNodeAttributes(eid);
  nodes.push({ id: eid, type: 'entity', name: attrs.name, freq: attrs.globalFrequency });
}

// INTERACTS edges between people
const seenEdges = new Set();
idx.graph.forEachEdge((e, attrs, src, tgt) => {
  if (attrs.type === 'INTERACTS') {
    const key = [src, tgt].sort().join('|');
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const srcNode = nodes.find(n => n.id === src);
    const tgtNode = nodes.find(n => n.id === tgt);
    if (srcNode && tgtNode) {
      edges.push({ source: src, target: tgt, type: 'INTERACTS', weight: attrs.weight || 1 });
    }
  }
});

// Build person→entity connections via person→cluster→entity
const personEntityWeight = new Map();
idx.graph.forEachNode((id, attrs) => {
  if (attrs.type !== 'person') return;
  idx.graph.forEachEdge(id, (e, ea, s, t) => {
    if (ea.type !== 'SENT_IN') return;
    const clusterId = s === id ? t : s;
    idx.graph.forEachEdge(clusterId, (e2, ea2, s2, t2) => {
      if (ea2.type !== 'MENTIONS') return;
      const entityId = s2 === clusterId ? t2 : s2;
      if (!topEntities.has(entityId)) return;
      const key = id + '|' + entityId;
      personEntityWeight.set(key, (personEntityWeight.get(key) || 0) + (ea2.weight || 1));
    });
  });
});

for (const [key, weight] of personEntityWeight) {
  const [src, tgt] = key.split('|');
  edges.push({ source: src, target: tgt, type: 'TOPIC', weight });
}

await writeFile('/tmp/betterrag_graph.json', JSON.stringify({ nodes, edges }, null, 2));
console.log('Exported:', nodes.length, 'nodes,', edges.length, 'edges');
