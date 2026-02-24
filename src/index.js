// ConversationIndex — main API facade

import { clusterMessages } from './cluster.js';
import { buildGraph, computePageRank, searchNodes, traverse, rankedByType, personProfile, annotateNode, hotNodes, graphStats } from './graph.js';
import { saveGraph, loadGraph, loadMeta, clearCache } from './cache.js';
import { SlackIngestor } from './ingestors/slack.js';
import { WhatsAppIngestor } from './ingestors/whatsapp.js';
import { MboxIngestor } from './ingestors/mbox.js';

export class ConversationIndex {
  constructor() {
    this.graph = null;
  }

  /**
   * Load cached graph or return null
   */
  async load() {
    this.graph = await loadGraph();
    return this.graph !== null;
  }

  /**
   * Ensure graph is loaded
   */
  async #ensureGraph() {
    if (!this.graph) {
      const loaded = await this.load();
      if (!loaded) throw new Error('No index found. Run `betterrag ingest <path>` first.');
    }
  }

  /**
   * Set email addresses that belong to "me" — for email ingestor filtering
   */
  setMyEmails(emails) {
    this.myEmails = emails;
  }

  /**
   * Parse and build graph from export path
   */
  async ingest(path, format) {
    const ingestor = this.#resolveIngestor(path, format);
    console.log(`Ingesting with ${format || 'auto-detected'} parser...`);

    const { messages, channels, people } = await ingestor.ingest(path);
    console.log(`Parsed ${messages.length} messages, ${people.length} people, ${channels.length} channels`);

    const clusters = clusterMessages(messages);
    console.log(`Clustered into ${clusters.length} conversations`);

    // If we have an existing graph, merge (re-build for now)
    this.graph = buildGraph(clusters, channels, people);
    computePageRank(this.graph);

    const stats = graphStats(this.graph);
    console.log(`Graph: ${stats.nodes} nodes, ${stats.edges} edges`);

    await saveGraph(this.graph, { ingestedFrom: path, format });
    console.log('Saved to cache.');

    return stats;
  }

  /**
   * Full-text search across entities, people, clusters
   */
  async query(text) {
    await this.#ensureGraph();
    return searchNodes(this.graph, text);
  }

  /**
   * Ranked people list
   */
  async people(opts = {}) {
    await this.#ensureGraph();
    return rankedByType(this.graph, 'person', opts.limit || 20);
  }

  /**
   * Person profile: topics, connections, activity
   */
  async person(name) {
    await this.#ensureGraph();
    const profile = personProfile(this.graph, name);
    if (profile) await saveGraph(this.graph); // persist visit
    return profile;
  }

  /**
   * Ranked channels
   */
  async channels(opts = {}) {
    await this.#ensureGraph();
    return rankedByType(this.graph, 'channel', opts.limit || 20);
  }

  /**
   * Conversation clusters, filterable
   */
  async clusters(opts = {}) {
    await this.#ensureGraph();
    let results = rankedByType(this.graph, 'cluster', opts.limit || 50);
    if (opts.channel) {
      results = results.filter(c => c.channel === opts.channel);
    }
    // Sort by time instead of pagerank for clusters
    results.sort((a, b) => b.startTime - a.startTime);
    if (opts.limit) results = results.slice(0, opts.limit);
    return results;
  }

  /**
   * BFS neighborhood exploration
   */
  async traverse(nodeId, hops = 2) {
    await this.#ensureGraph();
    const result = traverse(this.graph, nodeId, hops);
    if (result) await saveGraph(this.graph); // persist visit
    return result;
  }

  /**
   * Agent writes back to graph
   */
  async annotate(nodeId, annotation) {
    await this.#ensureGraph();
    const ok = annotateNode(this.graph, nodeId, annotation);
    if (ok) await saveGraph(this.graph);
    return ok;
  }

  /**
   * Most visited nodes/edges
   */
  async hot() {
    await this.#ensureGraph();
    return hotNodes(this.graph);
  }

  /**
   * Counts and stats
   */
  async stats() {
    await this.#ensureGraph();
    const s = graphStats(this.graph);
    const meta = await loadMeta();
    return { ...s, cache: meta };
  }

  /**
   * Full rebuild — clear cache and re-ingest
   */
  async reindex(path, format) {
    await clearCache();
    this.graph = null;
    if (path) return this.ingest(path, format);
  }

  #resolveIngestor(path, format) {
    const ingestors = {
      slack: new SlackIngestor(),
      whatsapp: new WhatsAppIngestor(),
      mbox: new MboxIngestor(this.myEmails || []),
      email: new MboxIngestor(this.myEmails || []),
    };
    if (format && ingestors[format]) return ingestors[format];
    // Auto-detect
    if (path.endsWith('.txt')) return ingestors.whatsapp;
    if (path.endsWith('.mbox')) return ingestors.mbox;
    return ingestors.slack; // default to slack for directories
  }
}
