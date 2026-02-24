// HTTP API for web UI

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppIngestor } from './ingestors/whatsapp.js';
import { GmailIngestor } from './ingestors/gmail.js';
import { clusterMessages } from './cluster.js';
import { buildGraph, computePageRank, graphStats } from './graph.js';
import { saveGraph } from './cache.js';
import { enrichCluster, applyEnrichment, isEnriched, batchEnrich } from './enrich.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Gmail job state (runs in background since IMAP is slow)
let gmailJob = { done: true, status: '', error: null, result: null };
// Enrichment batch job state
let enrichBatchJob = { done: true };

export async function startServer(idx, port = 3838) {
  await idx.load();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (path === '/' || path === '/index.html') {
        const html = await readFile(join(__dirname, 'ui.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      // API routes
      if (path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        const json = (data) => { res.writeHead(200); res.end(JSON.stringify(data)); };
        const param = (key) => url.searchParams.get(key);

        // WhatsApp upload/paste
        if (path === '/api/upload' && req.method === 'POST') {
          const body = await readBody(req);
          const text = body.text;
          const name = body.name || 'chat';
          if (!text) { res.writeHead(400); res.end('{"error":"text required"}'); return; }

          const wa = new WhatsAppIngestor();
          const { messages, channels, people } = wa.ingestText(text, name);
          if (messages.length === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'No messages parsed. Check the format.' }));
            return;
          }

          const clusters = clusterMessages(messages);
          idx.graph = buildGraph(clusters, channels, people);
          computePageRank(idx.graph);
          await saveGraph(idx.graph, { ingestedFrom: `upload:${name}`, format: 'whatsapp' });

          return json({
            ok: true,
            messages: messages.length,
            people: people.length,
            clusters: clusters.length,
            nodes: idx.graph.order,
            edges: idx.graph.size,
          });
        }

        // Gmail connect — kicks off background job
        if (path === '/api/gmail' && req.method === 'POST') {
          const body = await readBody(req);
          const { email, password, since, limit } = body;
          if (!email || !password) {
            res.writeHead(400);
            res.end('{"error":"email and password required"}');
            return;
          }

          // Start background job
          gmailJob = { done: false, status: 'Connecting to Gmail...', error: null, result: null };
          json({ started: true });

          // Run in background
          runGmailJob(idx, email, password, since || 3, limit || 500);
          return;
        }

        // Gmail progress polling
        if (path === '/api/gmail/status') {
          return json(gmailJob);
        }

        // Check if graph is loaded
        if (path === '/api/status') {
          return json({ loaded: idx.graph !== null });
        }

        if (path === '/api/stats') return json(await idx.stats());
        if (path === '/api/people') return json(await idx.people({ limit: parseInt(param('limit')) || 50 }));
        if (path === '/api/channels') return json(await idx.channels({ limit: parseInt(param('limit')) || 20 }));
        if (path === '/api/hot') return json(await idx.hot());

        if (path === '/api/query') {
          const q = param('q');
          if (!q) { res.writeHead(400); res.end('{"error":"q required"}'); return; }
          return json(await idx.query(q));
        }

        if (path === '/api/person') {
          const name = param('name');
          if (!name) { res.writeHead(400); res.end('{"error":"name required"}'); return; }
          const profile = await idx.person(name);
          return profile ? json(profile) : (res.writeHead(404), res.end('{"error":"not found"}'));
        }

        if (path === '/api/clusters') {
          return json(await idx.clusters({
            channel: param('channel'),
            limit: parseInt(param('limit')) || 30,
          }));
        }

        if (path === '/api/traverse') {
          const nodeId = param('id');
          if (!nodeId) { res.writeHead(400); res.end('{"error":"id required"}'); return; }
          const result = await idx.traverse(nodeId, parseInt(param('hops')) || 2);
          return result ? json(result) : (res.writeHead(404), res.end('{"error":"not found"}'));
        }

        if (path === '/api/annotate' && req.method === 'POST') {
          const body = await readBody(req);
          const ok = await idx.annotate(body.nodeId, body);
          return json({ ok });
        }

        if (path === '/api/graph/overview') {
          const nodes = [];
          const edges = [];
          const topEntities = new Set();

          // Get top 30 entities by frequency
          const ents = [];
          idx.graph.forEachNode((id, attrs) => {
            if (attrs.type === 'entity') ents.push({ id, freq: attrs.globalFrequency || 0 });
          });
          ents.sort((a, b) => b.freq - a.freq);
          for (const e of ents.slice(0, 30)) topEntities.add(e.id);

          // All people + top entities
          idx.graph.forEachNode((id, attrs) => {
            if (attrs.type === 'person') {
              nodes.push({ id, type: 'person', name: attrs.name, pagerank: attrs.pagerank || 0 });
            } else if (topEntities.has(id)) {
              nodes.push({ id, type: 'entity', name: attrs.name, globalFrequency: attrs.globalFrequency || 0 });
            }
          });

          const nodeIds = new Set(nodes.map(n => n.id));
          const seenEdges = new Set();

          // INTERACTS edges between people
          idx.graph.forEachEdge((e, attrs, src, tgt) => {
            if (attrs.type === 'INTERACTS' && nodeIds.has(src) && nodeIds.has(tgt)) {
              const key = [src, tgt].sort().join('|');
              if (!seenEdges.has(key)) {
                seenEdges.add(key);
                edges.push({ source: src, target: tgt, type: 'INTERACTS', weight: attrs.weight || 1 });
              }
            }
          });

          // Build person→entity TOPIC edges via person→cluster→entity
          const personEntityWeight = new Map();
          idx.graph.forEachNode((id, attrs) => {
            if (attrs.type !== 'person') return;
            idx.graph.forEachEdge(id, (e, ea, s, t) => {
              if (ea.type !== 'SENT_IN') return;
              const clusterId = s === id ? t : s;
              idx.graph.forEachEdge(clusterId, (e2, ea2, s2, t2) => {
                if (ea2.type !== 'MENTIONS' && ea2.type !== 'ABOUT') return;
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

          return json({ nodes, edges });
        }

        if (path === '/api/enrich' && req.method === 'POST') {
          const body = await readBody(req);
          const clusterId = body.clusterId;
          if (!clusterId) { res.writeHead(400); res.end('{"error":"clusterId required"}'); return; }
          if (!idx.graph.hasNode(clusterId)) { res.writeHead(404); res.end('{"error":"cluster not found"}'); return; }
          if (!process.env.OPENROUTER_API_KEY) { res.writeHead(500); res.end('{"error":"OPENROUTER_API_KEY not set"}'); return; }

          const attrs = idx.graph.getNodeAttributes(clusterId);
          if (attrs.type !== 'cluster') { res.writeHead(400); res.end('{"error":"node is not a cluster"}'); return; }

          const result = await enrichCluster(attrs.rawText || '', attrs.participants || []);
          applyEnrichment(idx.graph, clusterId, result);
          await saveGraph(idx.graph);
          return json({ ok: true, ...result });
        }

        if (path === '/api/enrich/batch' && req.method === 'POST') {
          if (!process.env.OPENROUTER_API_KEY) { res.writeHead(500); res.end('{"error":"OPENROUTER_API_KEY not set"}'); return; }
          const body = await readBody(req);
          const limit = body.limit || 20;
          const force = body.force || false;

          // Run in background
          json({ started: true });
          batchEnrich(idx.graph, { limit, force }).then(async (result) => {
            await saveGraph(idx.graph);
            enrichBatchJob = { done: true, ...result };
          }).catch(err => {
            enrichBatchJob = { done: true, error: err.message, enriched: 0, errors: 0 };
          });
          enrichBatchJob = { done: false, status: `Enriching up to ${limit} clusters...` };
          return;
        }

        if (path === '/api/enrich/status') {
          return json(enrichBatchJob);
        }

        if (path === '/api/graph') {
          const nodes = [];
          const edges = [];
          idx.graph.forEachNode((id, attrs) => {
            nodes.push({ id, ...attrs, rawText: undefined });
          });
          idx.graph.forEachEdge((id, attrs, source, target) => {
            edges.push({ id, source, target, ...attrs });
          });
          return json({ nodes, edges });
        }
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log(`betterrag web UI: http://localhost:${port}`);
  });
}

async function runGmailJob(idx, email, password, sinceMonths, limit) {
  try {
    const gmail = new GmailIngestor(email, password);

    // Override console.log to capture progress
    const origLog = console.log;
    console.log = (...args) => {
      const msg = args.join(' ');
      gmailJob.status = msg;
      origLog(...args);
    };

    const data = await gmail.ingest('[Gmail]/All Mail', { limit, since: monthsAgo(sinceMonths) });

    console.log = origLog;

    if (data.messages.length === 0) {
      gmailJob = { done: true, status: '', error: 'No messages found. Check credentials or date range.', result: null };
      return;
    }

    gmailJob.status = `Building graph from ${data.messages.length} messages...`;

    const clusters = clusterMessages(data.messages);
    idx.graph = buildGraph(clusters, data.channels, data.people);
    computePageRank(idx.graph);
    await saveGraph(idx.graph, { ingestedFrom: `gmail:${email}`, format: 'gmail' });

    const stats = graphStats(idx.graph);
    gmailJob = {
      done: true,
      status: '',
      error: null,
      messages: data.messages.length,
      people: data.people.length,
      clusters: clusters.length,
      nodes: stats.nodes,
      edges: stats.edges,
    };
  } catch (err) {
    console.log = console.log; // restore just in case
    gmailJob = { done: true, status: '', error: err.message, result: null };
  }
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}
