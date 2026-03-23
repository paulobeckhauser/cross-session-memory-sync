# Architecture: Cross-Session Memory Synchronization

## The Problem

OpenClaw sessions across channels share a single `memory.md` on disk, but each session maintains its own **independent conversation context**.

The shared `memory.md` doesn't solve this: it's loaded in full into every LLM call, so writing cross-session state there would be expensive (more tokens per call) and noisy (irrelevant details polluting every session).

## The Core Idea

Instead of sharing **conversations**, share **facts**.

Most of what people say in chat is noise — "ok", "thanks", "lol", "got it". The actual useful information is a tiny fraction: "My meeting is Thursday", "My dog's name is Bidu", "I decided to use PostgreSQL."

The system does three things:

1. **Listen** to every conversation and extract only the meaningful facts
2. **Store** those facts in a shared database
3. **Inject** relevant facts into other sessions before the LLM sees them

The rest is engineering to make this efficient, reliable, and bounded.

## Design Goals

| Goal | Constraint |
|---|---|
| No unified context | Each session manages its own context window independently |
| Near real-time | Knowledge propagates within seconds, not on restart |
| Conflict resolution | Graceful handling of contradictory facts across channels |
| Selective propagation | Noise stays local; only meaningful knowledge moves |

## High-Level Architecture

```
  WhatsApp            Slack             Telegram
  [context A]         [context B]       [context C]
      |                   |                  |
┌─────┼───────────────────┼──────────────────┼─────┐
│     |        Sync Layer (this system)      |     │
│     v                   v                  v     │
│  llm_input          llm_input          llm_input │
│  llm_output         llm_output         llm_output│
│     |                   |                  |     │
│     v                   v                  v     │
│  Noise Filter       Noise Filter       Noise    │
│     |                   |              Filter    │
│     v                   v                  v     │
│  Classify           Classify           Classify  │
│  (cheap LLM)        (cheap LLM)       (cheap)   │
│     |                   |                  |     │
│     v                   v                  v     │
│  Conflict           Conflict           Conflict  │
│  Detection          Detection          Detection │
│     |                   |                  |     │
│     └───────────────────┼──────────────────┘     │
│                         v                        │
│          +==============================+        │
│          ||    Knowledge DAG (SQLite)   ||        │
│          ||                            ||        │
│          ||  d0: raw facts             ||        │
│          ||  d1: summaries             ||        │
│          ||  d2: meta-summaries        ||        │
│          +==============================+        │
│                         |                        │
│                  before_prompt_build              │
│                         |                        │
│          ┌──────────────┼──────────────┐         │
│          v              v              v         │
│     Assemble       Assemble       Assemble       │
│     500 tokens     500 tokens     500 tokens     │
│          |              |              |         │
└──────────┼──────────────┼──────────────┼─────────┘
           v              v              v
      WhatsApp sees   Slack sees    Telegram sees
      Slack &         WhatsApp &    WhatsApp &
      Telegram facts  Telegram facts Slack facts
```

### Why This Approach Over Alternatives

| Alternative | Why Not |
|---|---|
| **Merge all contexts** | Explodes token costs. A 10-channel setup would send 10× the tokens per LLM call. |
| **Broadcast raw messages** | No filtering — casual messages ("lol", "ok") would pollute every session. |
| **Write everything to memory.md** | memory.md is loaded into every context in full. Same cost problem, plus no conflict resolution. |
| **Vector database** | Adds infrastructure complexity. OpenClaw runs locally — embedding + retrieval adds latency and deps for a problem solvable with structured extraction. |
| **Event bus (pub/sub)** | Requires sessions to be online simultaneously. Misses the core problem: sessions need facts, not raw messages. |

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

### Core Library (`core/`)

The core is deliberately decoupled from OpenClaw. `SyncEngine` exposes two operations:

1. **`onTurnComplete(turn)`** processes a conversation turn: extract facts, store them, trigger compression if thresholds are met.
2. **`getInjectionBlock(sessionKey, maxTokens)`** assembles a token-bounded context block for a session, excluding that session's own facts.

The same core can be adapted to any agent framework.

### Adapter (`adapters/openclaw/`)

The adapter wires the core into OpenClaw's plugin hook system:

| Hook | When it fires | What we do |
|---|---|---|
| `llm_input` | User sends a message | Capture the user's message, stripping any injected context prefix |
| `llm_output` | LLM responds | Pair with captured prompt, fire `onTurnComplete()` async |
| `before_prompt_build` | Before every LLM call | Call `getInjectionBlock()`, prepend result to system prompt |

The adapter also registers a cleanup service that archives old compressed and superseded nodes on startup.

---

## Extraction

When a message arrives on any channel, it passes through a pipeline.

### Noise Filter

A heuristic pre-filter rejects obvious noise before any LLM call. It checks three things: whether the message is empty or whitespace, whether it contains only emoji (matched via Unicode `\p{Emoji}` regex), and whether it matches one of 20 known noise patterns ("ok", "lol", "thanks", "got it", "sounds good", etc.).

No word-count gate — short messages like "allergic penicillin" or "vegan diet" carry critical facts. The pattern list handles the actual noise. This filter costs zero tokens and blocks ~60–70% of messages.

### LLM Classifier

Messages that survive the noise filter go to a cheap, configurable LLM. The classifier receives both the user message and the assistant's response, with a prompt that asks: "Does this conversation contain personal knowledge worth remembering?"

It returns either `null` (nothing worth saving) or structured nuggets:

```json
[
  {
    "fact": "Meeting with Acme Corp moved to Thursday",
    "category": "schedule",
    "confidence": 0.9
  }
]
```

Categories: `schedule`, `preference`, `decision`, `fact`, `relationship`, `task`.

The classifier prompt explicitly excludes general knowledge, greetings, small talk, and information the assistant provided that the user didn't confirm. Confidence scoring ranges from 0.9–1.0 for explicit statements down to 0.5–0.6 for weak signals. Facts below the confidence threshold (default 0.6) are discarded.

**Why cheap models are enough:** The classifier does structured JSON extraction with a rigid output format. This is pattern recognition, not creative reasoning. Models under **$1/1M input tokens** perform just as well as expensive ones.

| Provider | Default model | Cost/1M input tokens |
|---|---|---|
| Gemini | `gemini-2.0-flash-lite` | $0.075 (cheapest cloud) |
| Mistral | `mistral-small-latest` | $0.10 |
| DeepSeek | `deepseek-chat` | $0.14 |
| OpenAI | `gpt-4o-mini` | $0.15 (default) |
| Anthropic | `claude-haiku-4-5` | $0.80 |
| Groq | `llama-3.1-8b-instant` | Free tier |
| Ollama | `phi3:mini` | **Free (local)** |

### Extraction Data Flow

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
    │ 1. Noise Filter      │  Empty? Emoji-only? Pattern match?
    └──────┬──────────────┘
           │ passes
    ┌──────▼──────────────┐
    │ 2. LLM Classifier    │  Extract structured facts (JSON)
    └──────┬──────────────┘
           │ nuggets[]
    ┌──────▼──────────────┐
    │ 3. Confidence Gate   │  confidence ≥ 0.6?
    └──────┬──────────────┘
           │ passes
    ┌──────▼──────────────┐
    │ 4. Conflict Detection│  Word overlap check (30% / 60%)
    │                      │  Mark old fact superseded_by = new
    └──────┬──────────────┘
           │
    ┌──────▼──────────────┐
    │ 5. Store as d0 fact  │  Insert into Knowledge DAG
    └──────┬──────────────┘
           │
    ┌──────▼──────────────┐
    │ 6. Compression check │  Async, non-blocking
    │    d0 count ≥ 20?    │  → compress to d1
    │    d1 count ≥ 10?    │  → compress to d2
    │    d2 count ≥ 5?     │  → compress to d3
    └─────────────────────┘
```

All of this happens **asynchronously** — it doesn't slow down the user's conversation.

---

## Conflict Resolution

### Last-Write-Wins with Supersession

When a new fact conflicts with an existing one, the old fact is **superseded** — marked with a pointer to the new fact. It's not deleted (allowing recovery and audit), but it's excluded from active queries.

The latest fact wins. Simple, predictable, matches how humans think ("I changed my mind").

### How Conflicts Are Detected

The `contentOverlaps()` function normalizes both strings (lowercase, strip punctuation), removes 87 English stop words, and calculates word overlap ratio as `shared_words / incoming_words`.

**Same-category conflicts** use a looser threshold: overlap > **30%**, or 2+ shared entity words (≥4 characters), or 1+ entity match when there are ≤2 total entities.

**Cross-category conflicts** require > **60%** word overlap.

### Example

```
T=0   WhatsApp: "My favorite color is blue"
      → Store as f1: {fact: "favorite color is blue", category: "preference"}

T=10s Slack: "Actually my favorite color is green"
      → Extract: {fact: "favorite color is green", category: "preference"}
      → Same category, normalize: "favorite color blue" vs "favorite color green"
      → Overlap: "favorite", "color" = 2/3 = 67% > 30% → CONFLICT
      → Mark f1.superseded_by = f2.id
      → Store f2

T=15s Telegram: "What's my favorite color?"
      → Query: WHERE superseded_by IS NULL
      → Returns f2 only ("favorite color is green")
```

### Simultaneous Updates

If two channels extract conflicting facts at the exact same instant, SQLite's ACID guarantees serialize the INSERTs. The transaction that completes second detects the first as a conflict. One supersedes the other deterministically. This is racy but always consistent — no split-brain, no data loss.

---

## Storage: The Knowledge DAG

Over time, raw facts accumulate into the thousands. Injecting all of them into every LLM call would blow the token budget. The system **compresses** old facts into summaries, organized as a directed acyclic graph.

### Hierarchical Compression

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

| Depth | Trigger | Result |
|---|---|---|
| d0 → d1 | 20 facts in one category | 1 paragraph summary |
| d1 → d2 | 10 summaries in one category | 1 thematic summary |
| d2 → d3 | 5 meta-summaries | 1 high-level summary |
| Max depth: d4 | | |

Compression is **per-category**. Schedule facts compress with schedule facts. Preferences compress with preferences. This prevents nonsensical summaries mixing "My meeting is Monday" with "My dog's name is Bidu."

### Compression Resilience

If the LLM fails during compression (API down, rate limited), the system escalates:

1. **Normal:** compress all facts at that depth and category
2. **Aggressive:** retry with most recent 50% only (smaller input)
3. **Deterministic fallback:** join facts with "; " separator (no LLM needed)

Compression never blocks the pipeline. Worst case: facts stay uncompressed and are injected individually.

### SQLite Schema

```sql
CREATE TABLE dag_nodes (
  id              TEXT PRIMARY KEY,
  depth           INTEGER NOT NULL DEFAULT 0,
  content         TEXT NOT NULL,
  category        TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  source_session  TEXT,
  source_channel  TEXT,
  parent_id       TEXT,
  created_at      TEXT NOT NULL,
  superseded_by   TEXT,
  is_compressed   INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT
);

CREATE TABLE dag_lineage (
  summary_id  TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  PRIMARY KEY (summary_id, source_id)
);

CREATE INDEX idx_depth ON dag_nodes(depth);
CREATE INDEX idx_active ON dag_nodes(superseded_by) WHERE superseded_by IS NULL;
CREATE INDEX idx_uncompressed ON dag_nodes(is_compressed) WHERE is_compressed = 0;
CREATE INDEX idx_parent ON dag_nodes(parent_id);
CREATE INDEX idx_created ON dag_nodes(created_at);
CREATE INDEX idx_archived ON dag_nodes(archived_at) WHERE archived_at IS NULL;
```

### Why SQLite?

SQLite matches OpenClaw's local-first philosophy. WAL mode enables concurrent reads from multiple sessions alongside a single writer. ACID transactions make compression atomic (mark children + insert summary in one transaction). It handles ~100 concurrent sessions comfortably, requires zero configuration, and adds no external services.

---

## Injection

Before **every** LLM call on **any** channel, the system runs the **assembler**.

### The Assembler

The assembler builds a markdown block of cross-session knowledge that fits within a **token budget** (default: 500 tokens). Token estimation uses a simple heuristic: `ceil(text.length / 4)`.

1. **Query** all active facts: not superseded, not compressed, not archived, and **not from the current session** (no echo).
2. **Partition** into recent (d0 raw facts) and background (d1+ summaries).
3. **Fill the budget** in priority order: recent facts first (most immediately useful), then background summaries. Stop at the 500-token limit.

### Injection Data Flow

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
    │     d0 facts → "Recent"          │
    │     d1+ summaries → "Background" │
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
    │ [whatsapp, 5min ago] Meeting      │
    │   with Acme moved to Thursday    │
    │ [telegram, 2h ago] Dog's name    │
    │   is Bidu                        │
    │                                   │
    │ ### Background                    │
    │ User prefers dark mode and        │
    │   VS Code for development        │
    └──────────────────────────────────┘
           │
           ▼
    Prepended to Slack session's
    LLM system prompt
```

### Why 500 Tokens?

100 tokens misses important context. 2,000 tokens adds cost to every single LLM call across every session. 500 tokens is roughly 375 words — enough for ~15–20 facts or a mix of facts and summaries. Cost: ~$0.001 per turn, ~$0.30/month for an active user.

---

## Integration with OpenClaw

The entire system is an **OpenClaw plugin** — no modifications to OpenClaw's core code.

### Plugin Structure

```
adapters/openclaw/
├── src/index.ts           # Plugin entry point (~500 lines)
├── openclaw.plugin.json   # Plugin manifest
└── package.json
```

### Registration

OpenClaw loads the plugin via `openclaw plugins install`. The plugin's `register(api)` function resolves the LLM provider API key (checking explicit config, then environment variable, then OpenClaw auth profiles), registers event hooks via `api.on()`, and registers a cleanup service via `api.registerService()`. The engine initializes lazily on first use.

The plugin uses OpenClaw's event hooks, not the exclusive ContextEngine slot. This means it coexists with LCM (Lossless Claw Memory) and other plugins without conflict.

### API Key Resolution

The adapter resolves credentials in priority order: explicit `classifierApiKey` in config, then environment variable (e.g., `OPENAI_API_KEY`), then OpenClaw auth profiles (`~/.openclaw/agents/main/agent/auth-profiles.json`). Ollama requires no key.

### Configuration

```json
{
  "plugins": {
    "entries": {
      "cross-session-sync": {
        "enabled": true,
        "config": {
          "classifierProvider": "openai",
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

The `extractionEnabled` and `injectionEnabled` flags allow disabling individual pipeline stages independently — useful if a specific hook breaks in a new OpenClaw release.

---

## Cost Analysis

### Token Costs Per Turn

| Operation | When | Cost |
|---|---|---|
| Noise filter | Every message | 0 tokens (heuristic) |
| Classification | Messages passing noise filter | ~200–400 tokens (cheap LLM) |
| Compression | When threshold hit (~every 20 facts) | ~300–600 tokens per batch |
| Injection | Every LLM call | ≤500 tokens added to context |

### Real-World Estimate

For a moderately active user (50 messages/day across channels): ~30 messages pass the noise filter, producing 6,000–12,000 classification tokens/day (~$0.001–$0.012 depending on provider). Compression runs 1–2 times/day at ~600–1,200 tokens (~$0.001). Injection adds 500 tokens × ~50 turns = 25,000 tokens of context cost (~$0.004). **Total overhead: ~$0.01–0.02/day.**

### Cost Savings vs. Alternatives

| Approach | Extra tokens/turn | Monthly cost (active user) |
|---|---|---|
| Merge all contexts | +10,000–50,000 | $15–75 |
| Broadcast raw messages | +2,000–10,000 | $3–15 |
| **Knowledge DAG (this)** | **+500 (bounded)** | **$0.30–0.60** |

---

## Design Decisions & Trade-offs

### LLM Classification vs. Rule-Based Extraction

**Chose:** cheap LLM (configurable provider) with heuristic pre-filter.
**Why:** Rule-based extraction would miss nuance ("My dentist appointment got pushed back" → schedule change). The noise filter handles obvious rejects for free; the LLM handles semantic understanding.
**Trade-off:** adds ~$0.01/day cost and ~200ms latency per classification. Can be eliminated entirely with Ollama (local, free).

### SQLite vs. Distributed Store

**Chose:** SQLite with WAL mode.
**Why:** OpenClaw runs locally. Adding PostgreSQL or Redis would violate the local-first constraint. SQLite handles dozens of sessions and thousands of facts.
**Trade-off:** single-machine only. If cloud deployment is needed, swap the `DAGStore` implementation (the interface is clean).

### Last-Write-Wins vs. CRDT/Merge

**Chose:** last-write-wins with supersession pointers.
**Why:** CRDTs solve convergence across replicas — a problem that doesn't exist here, since all sessions write to the same SQLite file. LWW is simple and predictable.
**Trade-off:** if two conflicting facts arrive in the same millisecond, the resolution is arbitrary (but consistent). Human typing ensures sufficient temporal separation in practice.

### Token-Bounded Injection vs. Semantic Retrieval

**Chose:** fixed budget (500 tokens), priority-ordered (recent facts first, then summaries).
**Why:** semantic retrieval adds latency and complexity. The priority ordering is a good-enough heuristic for most use cases.
**Trade-off:** a query about an old fact may not surface it if recent facts consume the budget. Compression mitigates this by rolling old facts into summaries.

### Fire-and-Forget Extraction vs. Blocking

**Chose:** extraction and compression run asynchronously.
**Why:** user-facing latency matters. Blocking the LLM response to wait for extraction would degrade the experience.
**Trade-off:** a fact extracted from turn N may not be available until turn N+1 on another session. The async delay is <1 second in practice.

### Per-Category Compression vs. Global

**Chose:** compress within categories.
**Why:** mixing "My meeting is Monday" with "My dog is named Bidu" in a single summary produces incoherent output. Category-scoped summaries remain interpretable.
**Trade-off:** more summary nodes (one per category), but each is more useful.

### Plugin vs. Core Modification

**Chose:** external OpenClaw plugin.
**Why:** survives upstream updates. Uses public plugin API only (`api.on()`, `api.registerService()`, `api.logger`, `api.pluginConfig`). No internal imports, no private methods, no direct database access.
**Trade-off:** limited to what the plugin API exposes. Can't modify session context directly — works around this by injecting via `before_prompt_build`.

---

## Summary

| Decision | Why |
|---|---|
| Extract facts, not forward messages | Noise stays local. Only meaning propagates. |
| SQLite, not Postgres/Redis | OpenClaw is local-first. No external services. |
| Last-write-wins conflicts | Simple, predictable. Matches "I changed my mind." |
| 500-token bounded injection | Fixed cost per turn. Doesn't grow with channels. |
| Hierarchical compression | DAG stays bounded. Old facts don't bloat the budget. |
| Plugin, not core modification | Survives upstream updates. Easy to install/remove. |
| Async extraction | Never slows down the user's conversation. |
| Cheap LLM classifier (< $1/1M) | Structured extraction doesn't need expensive models. |
| Multi-provider support | Not locked to OpenAI. Can run fully local with Ollama. |

The total cost overhead is about **$0.01–0.02/day** for a moderately active user.

---

## Potential Problems

| Problem | Impact | Details |
|---|---|---|
| **Cross-channel fact leakage** | Critical | No channel privacy — facts from private DMs get injected into group channels. `source_channel` is stored but never used for filtering. |
| **English-only assumptions** | High | Stop words (conflict detection), token estimation (`ceil(len/4)` breaks for CJK), and noise patterns all assume English. |
| **Conflict detection race** | Medium | Read → check → insert isn't transactional. Simultaneous extractions can both insert before either detects the conflict. |
| **Compression fallback** | Medium | LLM failure falls back to `facts.join("; ")` — no actual compression, loses temporal ordering, keeps contradictions. |
| **500-token budget at scale** | Medium | ~16 facts max. With 5+ channels, facts are silently dropped. Summaries (historical knowledge) are cut first. |
| **Non-atomic deduplication** | Low | Global `lastProcessedMessageKey` variable has a race window — rapid duplicate hooks can both pass the check. |
| **Relevance window unenforced** | Low | `relevanceWindowHours` only applies to cleanup, not to `getActiveNodes()`. Old uncompressed facts persist in injection indefinitely. |

---

## Next Steps

| Priority | Task | Approach |
|---|---|---|
| **P0** | Channel privacy | Add `privateChannels` config; filter by `source_channel` in `getActiveNodes()` |
| **P0** | Transaction-safe conflicts | Wrap read → supersede → insert in `BEGIN IMMEDIATE` transaction |
| **P1** | Language-aware conflicts | Configurable per-language stop words; add `language` field to nugget schema |
| **P1** | Better token estimation | Use `ceil(len/2)` for non-ASCII-heavy text, or integrate `tiktoken` |
| **P2** | Channel-aware budget | Allocate tokens proportionally across source channels |
| **P2** | Smarter compression fallback | Sort by recency, deduplicate by overlap, prefix with timestamps |
| **P2** | Enforce fact TTL | Add `created_at` filter to `getActiveNodes()` using `relevanceWindowHours` |
| **P3** | i18n noise filter | Configurable pattern list or add common phrases for target languages |
| **P3** | Classifier output validation | Add Zod schema validation to classifier JSON parsing |
