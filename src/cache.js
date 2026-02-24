// Persistence — save/load graph to ~/.cache/betterrag/

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Graph from 'graphology';

const CACHE_DIR = join(homedir(), '.cache', 'betterrag');
const GRAPH_FILE = join(CACHE_DIR, 'graph.json');
const META_FILE = join(CACHE_DIR, 'meta.json');

async function ensureDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Save graph to disk as serialized JSON
 */
export async function saveGraph(graph, meta = {}) {
  await ensureDir();

  const serialized = graph.export();
  await writeFile(GRAPH_FILE, JSON.stringify(serialized));

  await writeFile(META_FILE, JSON.stringify({
    ...meta,
    savedAt: Date.now(),
    nodes: graph.order,
    edges: graph.size,
  }));
}

/**
 * Load graph from disk. Returns null if no cached graph.
 */
export async function loadGraph() {
  try {
    const raw = await readFile(GRAPH_FILE, 'utf-8');
    const serialized = JSON.parse(raw);
    const graph = new Graph({ multi: true, type: 'mixed' });
    graph.import(serialized);
    return graph;
  } catch {
    return null;
  }
}

/**
 * Load cache metadata
 */
export async function loadMeta() {
  try {
    const raw = await readFile(META_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear the cache
 */
export async function clearCache() {
  const { rm } = await import('node:fs/promises');
  try {
    await rm(CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }
}

export { CACHE_DIR };
