# betterrag

Conversation graph indexer — build a traversable knowledge graph from chat exports (Slack, WhatsApp, Gmail, mbox).

Turns flat message dumps into a richly connected graph of **people**, **channels**, **conversation clusters**, and **entities**, ranked by PageRank. Optionally enriches clusters with LLM-generated summaries, decisions, topics, and semantic relationships.

## Install

```bash
npm install -g betterrag
```

Requires Node.js 18+. Zero runtime dependencies beyond [graphology](https://graphology.github.io/).

## Quick Start

```bash
# Ingest a Slack export
betterrag ingest ./slack-export/

# Ingest WhatsApp chat
betterrag ingest chat.txt --format whatsapp

# Pull from Gmail directly
betterrag gmail --email you@gmail.com --password <app-password> --limit 500 --since 6

# Merge a second source into existing graph
betterrag merge ./another-export/ --format slack

# Search the graph
betterrag query "project deadline"

# Explore people
betterrag people
betterrag person "Jane Smith"

# LLM enrichment (needs OpenRouter key)
OPENROUTER_API_KEY=sk-... betterrag enrich --limit 50

# Launch web UI
betterrag ui
```

## Commands

| Command | Description |
|---------|-------------|
| `ingest <path> [--format slack\|whatsapp\|mbox]` | Import chat/email export |
| `gmail --email <e> --password <p> [--limit N] [--since N]` | Pull from Gmail via IMAP |
| `merge <path> [--format ...]` | Merge second source into existing graph |
| `query <text>` | Search entities, people, clusters |
| `people [--limit N]` | List people ranked by PageRank |
| `person <name>` | Deep profile — topics, connections, activity |
| `channels` | List channels ranked |
| `clusters [--channel name] [--limit N]` | List conversation clusters |
| `traverse <nodeId> [--hops N]` | BFS neighborhood exploration |
| `annotate <nodeId> --type <t> --text <t>` | Add annotation to a node |
| `hot` | Most visited/annotated nodes |
| `stats` | Graph statistics |
| `enrich [--limit N] [--force]` | LLM-enrich clusters (needs `OPENROUTER_API_KEY`) |
| `ui [--port N]` | Launch web explorer (default port 3838) |
| `reindex [path]` | Force full rebuild |

## How It Works

1. **Ingest** — Parse messages from Slack JSON, WhatsApp `.txt`, Gmail IMAP, or `.mbox` files
2. **Cluster** — Group messages into conversation clusters by time proximity and channel
3. **Build graph** — Create nodes (people, channels, clusters, entities) and edges (SENT_IN, CONTAINS, PARTICIPATES, MENTIONS, CO_OCCURS, INTERACTS)
4. **PageRank** — Rank all nodes by importance
5. **TF-IDF entities** — Extract key terms as entity nodes
6. **Enrich (optional)** — LLM summarizes clusters, extracts decisions/topics, and creates semantic relationship edges

## LLM Enrichment

The `enrich` command uses OpenRouter (Gemini Flash Lite by default) to analyze each conversation cluster and:

- Generate a 1-2 sentence **summary**
- Extract **decisions** and action items
- Identify **topics** (max 5 per cluster)
- Classify **sentiment** (productive, casual, urgent, tense, informational)
- Discover **relationships** — freeform typed edges like MANAGES, BLOCKED_BY, DEPENDS_ON, OWNS, etc.

Enrichment grows the graph organically. The LLM creates real edges that future queries can traverse — no fixed schema, the vocabulary expands with your data.

```bash
OPENROUTER_API_KEY=sk-or-... betterrag enrich --limit 100
```

## Web UI

`betterrag ui` launches an interactive graph explorer at `http://localhost:3838` with:

- Force-directed graph visualization on canvas
- Full-text search with graph highlighting
- Social graph overview (people + top entities)
- Click any node for deep detail — neighbors, edges, enrichment summaries
- One-click "Enrich with AI" button per cluster

## Programmatic API

```js
import { ConversationIndex } from 'betterrag';

const idx = new ConversationIndex();
await idx.ingest('./slack-export/');

// Search
const results = await idx.query('project deadline');

// People
const people = await idx.people({ limit: 10 });
const profile = await idx.person('Jane Smith');

// Traverse
const neighborhood = await idx.traverse('person:Jane Smith', 2);

// Annotate
await idx.annotate('cluster:42', { type: 'note', text: 'Important meeting', by: 'agent' });

// Stats
const stats = await idx.stats();
```

## Graph Structure

**Node types:** `person`, `channel`, `cluster`, `entity`

**Edge types (mechanical):** `SENT_IN`, `CONTAINS`, `PARTICIPATES`, `MENTIONS`, `CO_OCCURS`, `INTERACTS`

**Edge types (LLM enrichment):** `ABOUT`, `DECIDED`, plus any freeform type the LLM discovers (e.g. `MANAGES`, `BLOCKED_BY`, `ESCALATED_TO`, `DEPENDS_ON`)

## License

MIT
