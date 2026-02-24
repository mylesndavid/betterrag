#!/usr/bin/env node

// CLI entry point for betterrag

import { ConversationIndex } from './index.js';

const idx = new ConversationIndex();
const [,, command, ...args] = process.argv;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      flags[key] = val;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function truncate(str, len = 80) {
  if (!str) return '';
  const line = str.replace(/\n/g, ' ');
  return line.length > len ? line.slice(0, len) + '...' : line;
}

async function main() {
  try {
    switch (command) {
      case 'ingest': {
        const { flags, positional } = parseFlags(args);
        const path = positional[0];
        if (!path) { console.error('Usage: betterrag ingest <path> [--format slack|whatsapp|mbox|gmail]'); process.exit(1); }
        if (flags.email) idx.setMyEmails(flags.email.split(','));
        await idx.ingest(path, flags.format);
        break;
      }

      case 'gmail': {
        const { flags } = parseFlags(args);
        const email = flags.email;
        const password = flags.password;
        if (!email || !password) {
          console.error('Usage: betterrag gmail --email you@gmail.com --password <app-password> [--limit 500] [--since 3]');
          console.error('\nGet an app password at: https://myaccount.google.com/apppasswords');
          process.exit(1);
        }
        const { GmailIngestor } = await import('./ingestors/gmail.js');
        const gmail = new GmailIngestor(email, password);
        const limit = parseInt(flags.limit) || 500;
        const sinceMonths = parseInt(flags.since) || 3;
        const data = await gmail.ingest('[Gmail]/All Mail', { limit, since: monthsAgo(sinceMonths) });
        console.log(`Parsed ${data.messages.length} messages, ${data.people.length} people, ${data.channels.length} threads`);

        if (data.messages.length === 0) { console.log('No messages found.'); break; }

        const { clusterMessages } = await import('./cluster.js');
        const { buildGraph, computePageRank, graphStats } = await import('./graph.js');
        const { saveGraph } = await import('./cache.js');

        const clusters = clusterMessages(data.messages);
        console.log(`Clustered into ${clusters.length} conversations`);

        idx.graph = buildGraph(clusters, data.channels, data.people);
        computePageRank(idx.graph);

        const stats = graphStats(idx.graph);
        console.log(`Graph: ${stats.nodes} nodes, ${stats.edges} edges`);

        await saveGraph(idx.graph, { ingestedFrom: `gmail:${email}`, format: 'gmail' });
        console.log('Saved to cache.');
        break;
      }

      case 'query': {
        const text = args.join(' ');
        if (!text) { console.error('Usage: betterrag query <text>'); process.exit(1); }
        const results = await idx.query(text);
        if (results.length === 0) { console.log('No results found.'); break; }
        for (const r of results.slice(0, 20)) {
          console.log(`  [${r.type}] ${r.id} — ${r.name || truncate(r.rawText, 60)} (score: ${r.searchScore})`);
        }
        break;
      }

      case 'people': {
        const { flags } = parseFlags(args);
        const results = await idx.people({ limit: parseInt(flags.limit) || 20 });
        console.log(`\nTop ${results.length} people by PageRank:\n`);
        for (let i = 0; i < results.length; i++) {
          const p = results[i];
          console.log(`  ${i + 1}. ${p.name} (rank: ${p.pagerank?.toFixed(6) || 'n/a'})`);
        }
        break;
      }

      case 'person': {
        const name = args.join(' ');
        if (!name) { console.error('Usage: betterrag person <name>'); process.exit(1); }
        const profile = await idx.person(name);
        if (!profile) { console.log(`Person "${name}" not found.`); break; }
        console.log(`\n${profile.name}`);
        console.log(`  PageRank: ${profile.pagerank?.toFixed(6) || 'n/a'}`);
        console.log(`  Conversations: ${profile.clusterCount}`);
        if (profile.channels.length) {
          console.log(`\n  Channels:`);
          for (const ch of profile.channels.slice(0, 10)) {
            console.log(`    #${ch.name} (${ch.messageCount} msgs)`);
          }
        }
        if (profile.interactions.length) {
          console.log(`\n  Top interactions:`);
          for (const p of profile.interactions.slice(0, 10)) {
            console.log(`    ${p.name} (weight: ${p.weight})`);
          }
        }
        if (profile.topics.length) {
          console.log(`\n  Topics:`);
          for (const t of profile.topics.slice(0, 15)) {
            console.log(`    ${t.name} (${t.weight.toFixed(1)})`);
          }
        }
        break;
      }

      case 'channels': {
        const { flags } = parseFlags(args);
        const results = await idx.channels({ limit: parseInt(flags.limit) || 20 });
        console.log(`\nChannels (${results.length}):\n`);
        for (const ch of results) {
          console.log(`  #${ch.name} [${ch.channelType}] (rank: ${ch.pagerank?.toFixed(6) || 'n/a'})`);
        }
        break;
      }

      case 'clusters': {
        const { flags } = parseFlags(args);
        const results = await idx.clusters({
          channel: flags.channel,
          limit: parseInt(flags.limit) || 20,
        });
        console.log(`\nConversation clusters (${results.length}):\n`);
        for (const c of results) {
          const time = formatTime(c.startTime);
          console.log(`  ${c.id} | #${c.channel} | ${time} | ${c.participantCount} people, ${c.messageCount} msgs`);
          console.log(`    ${truncate(c.rawText, 100)}`);
        }
        break;
      }

      case 'traverse': {
        const { flags, positional } = parseFlags(args);
        const nodeId = positional[0];
        if (!nodeId) { console.error('Usage: betterrag traverse <nodeId> [--hops N]'); process.exit(1); }
        const hops = parseInt(flags.hops) || 2;
        const result = await idx.traverse(nodeId, hops);
        if (!result) { console.log(`Node "${nodeId}" not found.`); break; }
        console.log(`\nTraversal from ${nodeId} (${hops} hops, ${result.length} nodes):\n`);
        for (const n of result) {
          const prefix = '  '.repeat(n.depth + 1);
          const edges = n.edgesFromParent?.map(e => e.type).join(', ') || '';
          console.log(`${prefix}[${n.type}] ${n.id}${edges ? ` ← ${edges}` : ''}`);
        }
        break;
      }

      case 'annotate': {
        const { flags, positional } = parseFlags(args);
        const nodeId = positional[0];
        if (!nodeId || !flags.type || !flags.text) {
          console.error('Usage: betterrag annotate <nodeId> --type <type> --text <text>');
          process.exit(1);
        }
        const ok = await idx.annotate(nodeId, {
          type: flags.type,
          text: flags.text,
          by: 'cli',
          targetEntity: flags.entity,
        });
        console.log(ok ? `Annotated ${nodeId}` : `Node "${nodeId}" not found.`);
        break;
      }

      case 'hot': {
        const results = await idx.hot();
        if (results.length === 0) { console.log('No visited or annotated nodes yet.'); break; }
        console.log(`\nHot nodes:\n`);
        for (const n of results) {
          console.log(`  [${n.type}] ${n.id} — visits: ${n.visit_count}, annotations: ${n.annotations?.length || 0}, heat: ${n.heat}`);
        }
        break;
      }

      case 'merge': {
        const { flags, positional } = parseFlags(args);
        const path = positional[0];
        if (!path) {
          console.error('Usage: betterrag merge <path> [--format slack|whatsapp|mbox]');
          console.error('Merges a second data source into the existing graph.');
          process.exit(1);
        }
        // Load existing graph
        await idx.load();
        if (!idx.graph) { console.error('No existing graph. Run ingest first.'); process.exit(1); }
        const beforeStats = { nodes: idx.graph.order, edges: idx.graph.size };
        console.log(`Existing graph: ${beforeStats.nodes} nodes, ${beforeStats.edges} edges`);

        // Build a temporary graph from the new source
        const { clusterMessages: clusterMerge } = await import('./cluster.js');
        const { buildGraph: buildMerge, computePageRank: prMerge, mergeGraphs, graphStats: gsMerge } = await import('./graph.js');
        const { saveGraph: saveMerge } = await import('./cache.js');

        const ingestor = idx.constructor.prototype;
        let data;
        if (flags.format === 'gmail' || flags.email) {
          const { GmailIngestor } = await import('./ingestors/gmail.js');
          const gmail = new GmailIngestor(flags.email, flags.password);
          const limit = parseInt(flags.limit) || 500;
          const sinceMonths = parseInt(flags.since) || 3;
          data = await gmail.ingest('[Gmail]/All Mail', { limit, since: monthsAgo(sinceMonths) });
        } else {
          // File-based ingest
          await idx.load();
          const tempIdx = new (await import('./index.js')).ConversationIndex();
          const fmt = flags.format;
          const { SlackIngestor } = await import('./ingestors/slack.js');
          const { WhatsAppIngestor } = await import('./ingestors/whatsapp.js');
          const { MboxIngestor } = await import('./ingestors/mbox.js');
          const ingestors = { slack: new SlackIngestor(), whatsapp: new WhatsAppIngestor(), mbox: new MboxIngestor([]) };
          const ing = fmt && ingestors[fmt] ? ingestors[fmt] :
            path.endsWith('.txt') ? ingestors.whatsapp :
            path.endsWith('.mbox') ? ingestors.mbox : ingestors.slack;
          data = await ing.ingest(path);
        }

        console.log(`New source: ${data.messages.length} messages, ${data.people.length} people`);
        if (data.messages.length === 0) { console.log('No messages found.'); break; }

        const clusters = clusterMerge(data.messages);
        const sourceGraph = buildMerge(clusters, data.channels, data.people);

        // Merge into existing
        const result = mergeGraphs(idx.graph, sourceGraph);
        prMerge(idx.graph);
        console.log(`Merged: +${result.nodes} new nodes, +${result.edges} new edges, ${result.merged} people matched`);

        const afterStats = gsMerge(idx.graph);
        console.log(`Combined graph: ${afterStats.nodes} nodes, ${afterStats.edges} edges`);

        await saveMerge(idx.graph, { ingestedFrom: 'merged', format: 'multi' });
        console.log('Saved.');
        break;
      }

      case 'stats': {
        const s = await idx.stats();
        console.log(`\nGraph Statistics:`);
        console.log(`  Nodes: ${s.nodes}`);
        console.log(`  Edges: ${s.edges}`);
        console.log(`\n  Node types:`);
        for (const [type, count] of Object.entries(s.nodeTypes)) {
          console.log(`    ${type}: ${count}`);
        }
        console.log(`\n  Edge types:`);
        for (const [type, count] of Object.entries(s.edgeTypes)) {
          console.log(`    ${type}: ${count}`);
        }
        if (s.cache) {
          console.log(`\n  Cache:`);
          console.log(`    Saved: ${formatTime(s.cache.savedAt)}`);
          if (s.cache.ingestedFrom) console.log(`    Source: ${s.cache.ingestedFrom}`);
        }
        break;
      }

      case 'ui': {
        const { flags } = parseFlags(args);
        const port = parseInt(flags.port) || 3838;
        const { startServer } = await import('./server.js');
        await startServer(idx, port);
        break;
      }

      case 'enrich': {
        const { flags } = parseFlags(args);
        const limit = parseInt(flags.limit) || 50;
        const force = !!flags.force;

        if (!process.env.OPENROUTER_API_KEY) {
          console.error('OPENROUTER_API_KEY environment variable required.');
          console.error('Usage: OPENROUTER_API_KEY=sk-... betterrag enrich [--limit N] [--force]');
          process.exit(1);
        }

        await idx.load();
        if (!idx.graph) { console.error('No graph found. Run ingest first.'); process.exit(1); }

        const { batchEnrich } = await import('./enrich.js');
        console.log(`Enriching up to ${limit} clusters${force ? ' (force re-enrich)' : ''}...`);

        const result = await batchEnrich(idx.graph, {
          limit,
          force,
          onProgress: (i, total, id, summary) => {
            console.log(`  [${i}/${total}] ${id}: ${truncate(summary, 70)}`);
          },
        });

        const { saveGraph: save } = await import('./cache.js');
        await save(idx.graph);
        console.log(`\nDone: ${result.enriched} enriched, ${result.errors} errors.`);
        break;
      }

      case 'reindex': {
        const { flags, positional } = parseFlags(args);
        const meta = await import('./cache.js').then(m => m.loadMeta());
        const path = positional[0] || meta?.ingestedFrom;
        if (!path) { console.error('Usage: betterrag reindex [path] [--format slack|whatsapp]'); process.exit(1); }
        await idx.reindex(path, flags.format || meta?.format);
        break;
      }

      default:
        console.log(`betterrag — Conversation Graph Indexer

Commands:
  ingest <path> [--format slack|whatsapp|mbox]  Import chat/email export
  gmail --email <e> --password <p>              Pull directly from Gmail
        [--limit 500] [--since 3]               (months back, default 3)
  query <text>                                  Search entities/people/clusters
  people [--limit N]                            List people ranked by PageRank
  person <name>                                 Deep profile
  channels                                      List channels ranked
  clusters [--channel name] [--limit N]         List conversation clusters
  traverse <nodeId> [--hops N]                  Explore graph neighborhood
  annotate <nodeId> --type <t> --text <t>       Add annotation
  hot                                           Most visited/annotated paths
  stats                                         Index statistics
  ui [--port N]                                 Launch web explorer
  merge <path> [--format slack|whatsapp]          Merge second source into graph
  enrich [--limit N] [--force]                  LLM-enrich clusters (needs OPENROUTER_API_KEY)
  reindex [path]                                Force full rebuild`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
