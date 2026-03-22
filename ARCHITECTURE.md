# Architecture: Cross-Session Memory Synchronization

## Problem Statement

OpenClaw sessions across channels (WhatsApp, Slack, Telegram, etc.) share a single `memory.md` on disk, but each session maintains its own **independent conversation context** — the rolling message window sent to the LLM. If a user tells WhatsApp "My meeting moved to Thursday," Slack has no idea. The user must repeat themselves.

Naive solutions — merging all contexts into one — explode token costs and hit context window limits. Writing everything to `memory.md` pollutes every session with irrelevant noise.

## Design Goals

| Goal | Constraint |
|---|---|
| No unified context | Each session manages its own context window independently |
| Near real-time | Knowledge propagates within seconds, not on restart |
| Conflict resolution | Graceful handling of contradictory facts across channels |
| Selective propagation | Noise stays local; only meaningful knowledge moves |

## Solution: Knowledge DAG with Hierarchical Compression

The system operates as a **shared knowledge layer** that sits between sessions. Instead of merging contexts, it extracts discrete facts from conversations, stores them in a shared SQLite-backed DAG (Directed Acyclic Graph), and injects only relevant, token-bounded context into other sessions on demand.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  WhatsApp    │     │    Slack     │     │   Telegram   │
│   Session    │     │   Session    │     │   Session    │
│              │     │              │     │              │
│  [context A] │     │  [context B] │     │  [context C] │
│              │     │              │     │              │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │   ┌────────────────┼────────────────┐   │
       │   │     Sync Layer (this system)    │   │
       │   │                                 │   │
       ▼   │  ┌───────────────────────────┐  │   ▼
  llm_input │  │    Knowledge DAG          │  │ llm_input
  llm_output│  │    (SQLite)               │  │ llm_output
       │    │  │                           │  │   │
       │    │  │  d0: raw facts            │  │   │
       ▼    │  │  d1: summaries            │  │   ▼
  Extraction│  │  d2: meta-summaries       │  │ Extraction
       │    │  │       ...                 │  │   │
       │    │  └───────────────────────────┘  │   │
       │    │                                 │   │
       │    └────────────────┬────────────────┘   │
       │                     │                    │
       └─────────────────────┼────────────────────┘
                             │
                    before_prompt_build
                             │
                     Token-bounded
                     context injection
```

### Why This Approach Over Alternatives

| Alternative | Why Not |
|---|---|
| **Merge all contexts** | Explodes token costs. A 10-channel setup would send 10× the tokens per LLM call. |
| **Broadcast raw messages** | No filtering — casual messages ("lol", "ok") would pollute every session. |
| **Write everything to memory.md** | memory.md is loaded into every context in full. Same cost problem, plus no conflict resolution. |
| **Vector database** | Adds infrastructure complexity. OpenClaw runs locally — embedding + retrieval adds latency and deps for a problem solvable with structured extraction. |
| **Event bus (pub/sub)** | Requires sessions to be online simultaneously. Misses the core problem: sessions need facts, not raw messages. |

The Knowledge DAG approach is chosen because:
1. **Extracts meaning, not messages** — only personal facts enter the shared layer
2. **Token-bounded** — injection respects a configurable budget (default 500 tokens)
3. **Hierarchical** — old facts compress into summaries, keeping the DAG bounded
4. **Conflict-aware** — supersession mechanism handles contradictions
5. **Zero infrastructure** — SQLite, no external services

## Component Architecture

```
┌─────────────────────────────────────┐
│ Adapters (OpenClaw Plugin)          │  ← Framework-specific wiring
├─────────────────────────────────────┤
│ SyncEngine (Orchestrator)           │  ← Coordinates pipeline
├─────────────────────────────────────┤
│ Extraction Pipeline                 │  ← Data ingestion
│ (NoiseFilter → Classifier → Store)  │
├─────────────────────────────────────┤
│ Compressor                          │  ← Hierarchical summarization
├─────────────────────────────────────┤
│ Assembler                           │  ← Token-bounded retrieval
├─────────────────────────────────────┤
│ DAGStore (SQLite)                   │  ← Persistence + queries
└─────────────────────────────────────┘
```

### Core Library (`core/`) — Framework-Agnostic

The core is deliberately decoupled from OpenClaw. It exposes a `SyncEngine` with two main operations:

- **`onTurnComplete(turn)`** — Process a conversation turn (extract → store → compress)
- **`getInjectionBlock(sessionKey, maxTokens)`** — Assemble context for a session

This means the same core can be adapted to any agent framework — not just OpenClaw.

### Adapter (`adapters/openclaw/`) — OpenClaw Plugin

The adapter wires the core into OpenClaw's plugin hook system:

| Hook | Purpose |
|---|---|
| `llm_input` | Capture user message per session |
| `llm_output` | Trigger extraction after LLM responds |
| `before_prompt_build` | Inject cross-session context into prompt |

The adapter also registers a **cleanup service** for periodic archival of old facts.

## Data Flow

### Extraction Pipeline (Write Path)

```
User sends message on WhatsApp
         │
         ▼
    ┌─────────────┐
    │ llm_input    │  Capture user prompt
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ LLM responds │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ llm_output   │  Trigger extraction
    └──────┬──────┘
           │
    ┌──────▼──────────────┐
    │ 1. Noise Filter      │  Is this worth classifying?
    │    - Empty?          │  ← Reject
    │    - Emoji-only?     │  ← Reject
    │    - Pattern match?  │  ← Reject ("lol", "ok", "thanks")
    └──────┬──────────────┘
           │ passes
    ┌──────▼──────────────┐
    │ 2. LLM Classifier    │  Extract structured facts
    │    (gpt-4o-mini)     │
    │                      │
    │    Input: user msg   │
    │         + assistant  │
    │    Output: [{        │
    │      fact, category, │
    │      confidence      │
    │    }] or null        │
    └──────┬──────────────┘
           │ nuggets[]
    ┌──────▼──────────────┐
    │ 3. Confidence Gate   │  confidence ≥ 0.6?
    └──────┬──────────────┘
           │ passes
    ┌──────▼──────────────┐
    │ 4. Conflict Detection│  Does this contradict an existing fact?
    │    - Same-category:  │  30% word overlap → conflict
    │    - Cross-category: │  60% word overlap → conflict
    │    - Mark old fact   │  superseded_by = new fact
    └──────┬──────────────┘
           │
    ┌──────▼──────────────┐
    │ 5. Store as d0 fact  │  Insert into Knowledge DAG
    │    (SQLite)          │
    └──────┬──────────────┘
           │
    ┌──────▼──────────────┐
    │ 6. Compression check │  Async, non-blocking
    │    d0 count ≥ 20?    │  → compress to d1
    │    d1 count ≥ 10?    │  → compress to d2
    │    d2 count ≥ 5?     │  → compress to d3
    └─────────────────────┘
```

### Injection Pipeline (Read Path)

```
User sends message on Slack
         │
         ▼
    ┌──────────────────┐
    │ before_prompt_build│  Fires before every LLM call
    └──────┬───────────┘
           │
    ┌──────▼──────────────────────────┐
    │ Assembler: assembleContext()     │
    │                                  │
    │  1. Query active nodes           │
    │     WHERE superseded_by IS NULL  │
    │     AND is_compressed = 0        │
    │     AND archived_at IS NULL      │
    │     AND source_session ≠ current │
    │                                  │
    │  2. Partition:                    │
    │     - d0 facts → "Recent"        │
    │     - d1+ summaries → "Background│
    │                                  │
    │  3. Fill token budget (500):     │
    │     Header (5 tokens)            │
    │     Recent facts (priority)      │
    │     Background summaries (rest)  │
    └──────┬──────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────┐
    │ ## Cross-Session Context          │
    │                                   │
    │ ### Recent                        │
    │ - [whatsapp, 5min ago] Meeting    │
    │   with Acme moved to Thursday    │
    │ - [telegram, 2h ago] Dog's name  │
    │   is Bidu                        │
    │                                   │
    │ ### Background                    │
    │ - User prefers dark mode and      │
    │   VS Code for development        │
    └──────────────────────────────────┘
           │
           ▼
    Prepended to Slack session's
    LLM system prompt
```

## Conflict Resolution

### Strategy: Last-Write-Wins with Supersession

When a new fact conflicts with an existing one, the old fact is **superseded** — marked with a pointer to the new fact. It's not deleted (allowing recovery and audit), but it's excluded from active queries.

### How Conflicts Are Detected

The `contentOverlaps()` function uses two thresholds depending on whether facts share a category:

**Same-category conflicts** (looser — same topic area):
1. Normalize both strings (lowercase, remove punctuation)
2. Remove English stop words (109 common words)
3. Calculate word overlap ratio: `shared_words / incoming_words`
4. Conflict if overlap > **30%**
5. Additionally: extract "entity" words (≥4 characters). If 2+ shared entities, or 1+ entity match with ≤2 total entities → conflict

**Cross-category conflicts** (stricter — different topic areas):
- Requires > **60%** word overlap

### Example: Favorite Color Change

```
Timeline:
  T=0  WhatsApp: "My favorite color is blue"
       → Extract: {fact: "favorite color is blue", category: "preference", conf: 0.9}
       → Store as f1 (superseded_by: null)

  T=10s Slack: "Actually my favorite color is green"
       → Extract: {fact: "favorite color is green", category: "preference", conf: 0.9}
       → Conflict detection:
         - Same category ("preference")
         - Normalize: "favorite color blue" vs "favorite color green"
         - Overlap: "favorite", "color" = 2/3 = 67% > 30% ✓
         - Shared entities: "favorite", "color" = 2 ✓
         → CONFLICT with f1
       → Mark f1.superseded_by = f2.id
       → Store f2 (superseded_by: null)

  T=15s Telegram asks "What's my favorite color?"
       → Query: WHERE superseded_by IS NULL
       → Returns: f2 only ("favorite color is green")
       → Injected: "- [slack, 5s ago] favorite color is green"
```

### Edge Case: Simultaneous Updates

If two channels extract conflicting facts at the exact same instant:
- SQLite's ACID guarantees serialize the INSERTs
- The transaction that completes second will detect the first as a conflict
- Result: one supersedes the other deterministically (latest INSERT wins)
- This is racy but always consistent — no split-brain, no data loss

## Hierarchical Compression

### Why Compress?

Without compression, the DAG would grow unboundedly. With a 500-token injection budget, thousands of raw facts would either overflow the budget or require expensive filtering. Compression solves this by rolling up old facts into summaries.

### Compression Hierarchy

```
         ┌─────────────────────────────────┐
         │          d3 summary             │  ← 1 node: key life themes
         └──────────────┬──────────────────┘
                        │ compresses
         ┌──────────────┴──────────────────┐
         │          d2 summaries           │  ← 5+ d1 → 1 d2
         └──────────────┬──────────────────┘
                        │ compresses
    ┌───────────────────┴───────────────────┐
    │              d1 summaries             │  ← 10+ d0 → 1 d1
    └───────────────────┬───────────────────┘
                        │ compresses
┌───────────────────────┴───────────────────────┐
│                  d0 raw facts                  │  ← 20+ facts per category
│  "Meeting Monday 10am"  "Dog name is Bidu"    │
│  "Prefers dark mode"     "Using PostgreSQL"   │
└───────────────────────────────────────────────┘
```

**Thresholds (configurable):**
| Depth | Trigger | Result |
|---|---|---|
| d0 → d1 | 20 facts in one category | 1 paragraph summary |
| d1 → d2 | 10 summaries in one category | 1 thematic summary |
| d2 → d3 | 5 meta-summaries | 1 high-level summary |
| Max depth: d4 | | |

### Compression Resilience

If the LLM fails during compression (API down, rate limited), the system escalates:

1. **Level 1:** Try compressing all facts
2. **Level 2:** Retry with most recent 50% (smaller input)
3. **Level 3:** Deterministic fallback — join facts with "; " separator

Compression never blocks the pipeline. Worst case: facts stay uncompressed and are injected individually.

### Per-Category Compression

Facts are compressed **within their category** (schedule, preference, fact, etc.). This prevents mixing unrelated knowledge in summaries:

```
✓  "Meeting Monday" + "Meeting Wednesday" + "Standup Friday"
   → "User has meetings: Mon, Wed, Fri standup"

✗  "Meeting Monday" + "Dog named Bidu" + "Prefers dark mode"
   → Incoherent summary
```

## Cost Analysis

### Token Costs Per Turn

| Operation | When | Cost |
|---|---|---|
| Noise filter | Every message | 0 tokens (heuristic, no LLM) |
| Classification | Messages passing noise filter | ~200-400 tokens (gpt-4o-mini) |
| Compression | When threshold hit (~every 20 facts) | ~300-600 tokens per batch |
| Injection | Every LLM call | ≤500 tokens added to context |

### Real-World Estimate

For a moderately active user (50 messages/day across channels):
- ~30 messages pass noise filter → 30 classification calls
- ~6,000-12,000 tokens/day for classification (~$0.006-$0.012 with gpt-4o-mini)
- 1-2 compression runs/day → ~600-1,200 tokens (~$0.001)
- Injection: 500 tokens × ~50 turns = 25,000 tokens → context cost increase (~$0.004)
- **Total overhead: ~$0.01-0.02/day** — negligible

### Cost Savings vs. Alternatives

| Approach | Extra tokens/turn | Monthly cost (active user) |
|---|---|---|
| Merge all contexts | +10,000-50,000 | $15-75 |
| Broadcast raw messages | +2,000-10,000 | $3-15 |
| **Knowledge DAG (this)** | **+500 (bounded)** | **$0.30-0.60** |

## Storage Schema

### SQLite Tables

```sql
-- Knowledge nodes (facts and summaries)
CREATE TABLE dag_nodes (
  id             TEXT PRIMARY KEY,
  depth          INTEGER DEFAULT 0,    -- 0=fact, 1+=summary
  content        TEXT,
  category       TEXT,                 -- schedule|preference|decision|fact|relationship|task
  confidence     REAL DEFAULT 1.0,
  source_session TEXT,
  source_channel TEXT,
  parent_id      TEXT,                 -- points to containing summary
  created_at     TEXT,
  superseded_by  TEXT,                 -- conflict resolution pointer
  is_compressed  INTEGER DEFAULT 0,
  archived_at    TEXT                  -- soft-delete timestamp
);

-- Compression lineage (summary → children)
CREATE TABLE dag_lineage (
  summary_id TEXT,
  source_id  TEXT,
  PRIMARY KEY (summary_id, source_id)
);

-- Indexes for query performance
CREATE INDEX idx_depth        ON dag_nodes(depth);
CREATE INDEX idx_active       ON dag_nodes(superseded_by);
CREATE INDEX idx_uncompressed ON dag_nodes(is_compressed);
CREATE INDEX idx_parent       ON dag_nodes(parent_id);
CREATE INDEX idx_created      ON dag_nodes(created_at);
CREATE INDEX idx_archived     ON dag_nodes(archived_at);
```

### Why SQLite?

- **Local-first** — matches OpenClaw's philosophy, no external services
- **WAL mode** — concurrent reads from multiple sessions + single writer
- **ACID transactions** — compression (mark children + insert summary) is atomic
- **Zero-config** — no server, no connection string, just a file path
- **Sufficient scale** — handles ~100 concurrent sessions per agent comfortably

## Integration with OpenClaw

### Plugin Architecture

The adapter is an **external OpenClaw plugin** — it uses the public plugin API, not internal modifications:

```
adapters/openclaw/
├── src/index.ts           # Plugin entry point
├── openclaw.plugin.json   # Plugin manifest
└── package.json
```

**Registration flow:**
1. OpenClaw loads plugin via `openclaw plugins install`
2. Calls `register(api)` with the plugin API context
3. Plugin resolves OpenAI API key (env var or OpenClaw auth profiles)
4. Registers event hooks via `api.on()` (not `api.registerHook()` — uses the event API for real-time hooks)
5. Registers cleanup service via `api.registerService()`
6. Engine initializes lazily on first use

**Coexistence:** The plugin uses OpenClaw's event hooks, not the exclusive ContextEngine slot. This means it coexists with LCM (Lossless Claw Memory) and other plugins without conflict.

### Configuration

```json
{
  "plugins": {
    "entries": {
      "cross-session-sync": {
        "enabled": true,
        "config": {
          "classifierModel": "gpt-4o-mini",
          "extractionEnabled": true,
          "injectionEnabled": true,
          "compressionThreshold": 20,
          "maxInjectedTokens": 500,
          "relevanceWindowHours": 24
        }
      }
    }
  }
}
```

## Design Decisions & Trade-offs

### 1. LLM Classification vs. Rule-Based Extraction
**Chose:** LLM (gpt-4o-mini) with heuristic pre-filter.
**Why:** Rule-based extraction would miss nuance ("My dentist appointment got pushed back" → schedule change). The noise filter handles obvious rejects cheaply; the LLM handles semantic understanding.
**Trade-off:** Adds ~$0.01/day cost and ~200ms latency per classification. Acceptable given the alternative (missing important facts).

### 2. SQLite vs. Distributed Store
**Chose:** SQLite with WAL mode.
**Why:** OpenClaw runs locally. Adding PostgreSQL or Redis would violate the local-first constraint and add operational burden. SQLite handles the expected scale (dozens of sessions, thousands of facts).
**Trade-off:** Single-machine only. If multi-agent or cloud deployment is needed, swap the `DAGStore` implementation (interface is clean).

### 3. Last-Write-Wins vs. CRDT/Merge
**Chose:** Last-write-wins with supersession pointers.
**Why:** CRDTs solve a harder problem (convergence across replicas) that doesn't exist here — all sessions write to the same SQLite file. LWW is simple, predictable, and matches user mental models ("I changed my mind").
**Trade-off:** If two conflicting facts arrive in the same millisecond, the resolution is arbitrary (but consistent). In practice, human typing ensures sufficient temporal separation.

### 4. Token-Bounded Injection vs. Semantic Retrieval
**Chose:** Fixed budget (500 tokens), priority-ordered (recent facts first, then summaries).
**Why:** Semantic retrieval (e.g., embedding the current query and finding relevant facts) adds latency and complexity. The priority ordering (recent > background) is a good-enough heuristic for most use cases.
**Trade-off:** A query about an old fact may not surface it if recent facts consume the budget. Compression mitigates this by rolling old facts into summaries.

### 5. Fire-and-Forget Extraction vs. Blocking
**Chose:** Extraction and compression run asynchronously.
**Why:** User-facing latency matters. Blocking the LLM response to wait for extraction would degrade the experience.
**Trade-off:** A fact extracted from turn N may not be available until turn N+1 on another session. In practice, the async delay is <1 second — well within "near real-time."

### 6. Per-Category Compression vs. Global
**Chose:** Compress within categories.
**Why:** Mixing "My meeting is Monday" with "My dog is named Bidu" in a single summary produces incoherent output. Category-scoped summaries remain interpretable.
**Trade-off:** More summary nodes (one per category), but each is more useful.
