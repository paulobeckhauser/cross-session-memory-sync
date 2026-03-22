# Architecture: Cross-Session Memory Synchronization

## The Problem

Imagine you have one AI assistant, but you talk to it on multiple apps — WhatsApp, Slack, Telegram. Each app has its own conversation — its own "memory" of what you've been talking about.

If you tell WhatsApp "My meeting got moved to Thursday," and then ask Slack "When's my meeting?" — Slack has no idea. It never saw that message. The conversations are **isolated**.

OpenClaw sessions across channels share a single `memory.md` on disk, but each session maintains its own **independent conversation context** — the rolling message window sent to the LLM. The shared `memory.md` is not enough: writing everything there would be expensive (more tokens per LLM call) and noisy (irrelevant details polluting every session).

The naive fix — dump everything from every conversation into every other — explodes token costs. You'd be paying 10x for a 10-channel setup.

## The Core Idea

Instead of sharing **conversations**, share **facts**.

Most of what people say in chat is noise — "ok", "thanks", "lol", "got it". The actual useful information is a tiny fraction: "My meeting is Thursday", "My dog's name is Bidu", "I decided to use PostgreSQL."

The system does three things:

1. **Listen** to every conversation, extract only the meaningful facts
2. **Store** those facts in a shared database
3. **Inject** relevant facts into other sessions before the LLM sees them

That's it. The rest is engineering to make this efficient, reliable, and bounded.

## Design Goals

| Goal | Constraint |
|---|---|
| No unified context | Each session manages its own context window independently |
| Near real-time | Knowledge propagates within seconds, not on restart |
| Conflict resolution | Graceful handling of contradictory facts across channels |
| Selective propagation | Noise stays local; only meaningful knowledge moves |

## High-Level Architecture

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

| Hook | When it fires | What we do |
|---|---|---|
| `llm_input` | User sends a message | Capture the user's message |
| `llm_output` | LLM responds | Extract facts from the conversation turn |
| `before_prompt_build` | Before every LLM call | Inject cross-session context |

The adapter also registers a **cleanup service** for periodic archival of old facts.

---

## Step 1: Extraction — How facts get extracted

When you send a message on any channel, it goes through a pipeline:

### Noise Filter (free, no LLM call)

Before spending money on an LLM call, a cheap heuristic filter rejects obvious noise:

- Is the message empty or whitespace? **Reject.**
- Only emojis? **Reject.**
- Matches a known noise pattern? **Reject.** ("ok", "lol", "thanks", "got it", "sounds good", "yes", "no", "sure", etc.)

No word-count gate — short messages like "allergic penicillin" or "vegan diet" can carry critical facts. The pattern list handles the actual noise.

This filter costs zero tokens. It's just string matching. It blocks ~60-70% of messages from ever reaching the LLM.

### LLM Classifier (cheap, provider-agnostic)

Messages that survive the noise filter go to a small, cheap LLM. The provider is configurable — OpenAI (`gpt-4o-mini`), Gemini (`flash-lite`), DeepSeek, Mistral, Groq, Anthropic (`haiku`), or even a **local model via Ollama** (zero cost).

**Why cheap models are enough:** The classifier does structured JSON extraction — "is there a personal fact here? output JSON or null." This is pattern recognition with a rigid output format, not creative reasoning. Models under **$1/1M input tokens** perform just as well as expensive ones. The system warns if you configure a model above this ceiling.

| Provider | Default model | Cost/1M input tokens |
|---|---|---|
| Gemini | `gemini-2.0-flash-lite` | $0.075 (cheapest cloud) |
| Mistral | `mistral-small-latest` | $0.10 |
| DeepSeek | `deepseek-chat` | $0.14 |
| OpenAI | `gpt-4o-mini` | $0.15 (default) |
| Anthropic | `claude-haiku-4-5` | $0.80 |
| Groq | `llama-3.1-8b-instant` | Free tier |
| Ollama | `phi3:mini` | **Free (local)** |

The classifier gets both the user message AND the assistant's response, and asks:

> "Does this conversation contain personal knowledge worth remembering?"

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

Categories are: `schedule`, `preference`, `decision`, `fact`, `relationship`, `task`.

The confidence score lets the system skip weak extractions (below 0.6).

### Extraction Pipeline (full data flow)

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
    │    (configurable)    │
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

All of this happens **asynchronously** — it doesn't slow down the user's conversation.

---

## Step 2: Conflict Resolution

### Strategy: Last-Write-Wins with Supersession

When a new fact conflicts with an existing one, the old fact is **superseded** — marked with a pointer to the new fact. It's not deleted (allowing recovery and audit), but it's excluded from active queries.

**Result: the latest fact wins.** Simple, predictable, matches how humans think ("I changed my mind").

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

---

## Step 3: Storage — The Knowledge DAG

"DAG" stands for Directed Acyclic Graph. Think of it as a **tree of facts and summaries**.

### Why not just a flat list of facts?

Because over time, you'd accumulate thousands of facts. You can't inject thousands of facts into every LLM call — that would blow the token budget. So the system **compresses** old facts into summaries.

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

**Thresholds (configurable):**
| Depth | Trigger | Result |
|---|---|---|
| d0 → d1 | 20 facts in one category | 1 paragraph summary |
| d1 → d2 | 10 summaries in one category | 1 thematic summary |
| d2 → d3 | 5 meta-summaries | 1 high-level summary |
| Max depth: d4 | | |

**Compression is per-category.** Schedule facts compress with schedule facts. Preferences compress with preferences. This prevents nonsensical summaries mixing "My meeting is Monday" with "My dog's name is Bidu."

### Compression Resilience

If the LLM fails during compression (API down, rate limited), the system escalates:

1. **Level 1:** Try compressing all facts
2. **Level 2:** Retry with most recent 50% (smaller input)
3. **Level 3:** Deterministic fallback — join facts with "; " separator

Compression never blocks the pipeline. Worst case: facts stay uncompressed and are injected individually.

### SQLite Schema

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
```

### Why SQLite?

- **Local-first** — matches OpenClaw's philosophy, no external services
- **WAL mode** — concurrent reads from multiple sessions + single writer
- **ACID transactions** — compression (mark children + insert summary) is atomic
- **Zero-config** — no server, no connection string, just a file path
- **Sufficient scale** — handles ~100 concurrent sessions per agent comfortably

---

## Step 4: Injection — How other sessions see the facts

Before **every** LLM call on **any** channel, the system runs the **assembler**.

### The Assembler

The assembler's job: build a markdown block of cross-session knowledge that fits within a **token budget** (default: 500 tokens).

1. **Query active facts** — everything that's:
   - Not superseded (no newer version exists)
   - Not compressed (not folded into a summary)
   - Not archived
   - **Not from the current session** (no echo — you don't need to be told what you just said)
2. **Partition** into two groups:
   - **Recent** = d0 raw facts (most specific, most timely)
   - **Background** = d1+ summaries (broader context)
3. **Fill the budget**, priority-ordered:
   - Recent facts go first (they're the most immediately useful)
   - Background summaries fill the remaining space
   - Stop when the 500-token budget is full

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

### Why 500 tokens?

- **Too few** (100) → misses important context
- **Too many** (2000) → adds cost to every single LLM call across every session
- **500** → roughly 375 words, enough for ~15-20 facts or a mix of facts and summaries
- Cost: ~$0.001 per turn → ~$0.30/month for an active user

---

## The Full Picture

```
WhatsApp          Slack            Telegram
   |                |                 |
   |  llm_input     |                 |
   |  llm_output    |                 |
   |       |        |                 |
   |       v        |                 |
   |  +---------+   |                 |
   |  | Noise   |   |                 |
   |  | Filter  |   |                 |
   |  +----+----+   |                 |
   |       v        |                 |
   |  +---------+   |                 |
   |  |Classify |   |                 |
   |  |(cheap)  |   |                 |
   |  +----+----+   |                 |
   |       v        |                 |
   |  +---------+   |                 |
   |  |Conflict |   |                 |
   |  |Detection|   |                 |
   |  +----+----+   |                 |
   |       v        |                 |
   |  +=====================================+
   |  ||     Knowledge DAG (SQLite)         ||
   |  ||                                    ||
   |  ||  d0: "Meeting Thursday" (whatsapp) ||
   |  ||  d0: "Dog is Bidu" (telegram)      ||
   |  ||  d1: "Prefers dark mode, VS Code"  ||
   |  +=====================================+
   |            |                 |
   |            | before_prompt   | before_prompt
   |            | _build          | _build
   |            v                 v
   |       +---------+     +---------+
   |       |Assemble |     |Assemble |
   |       |500 token|     |500 token|
   |       | block   |     | block   |
   |       +----+----+     +----+----+
   |            v                v
   |       Slack sees        Telegram sees
   |       WhatsApp's        WhatsApp's
   |       facts             facts
```

---

## Integration with OpenClaw

The entire system is an **OpenClaw plugin** — no modifications to OpenClaw's core code.

### Plugin Architecture

```
adapters/openclaw/
├── src/index.ts           # Plugin entry point
├── openclaw.plugin.json   # Plugin manifest
└── package.json
```

**Registration flow:**
1. OpenClaw loads plugin via `openclaw plugins install`
2. Calls `register(api)` with the plugin API context
3. Plugin resolves LLM provider API key (env var or OpenClaw auth profiles)
4. Registers event hooks via `api.on()` for real-time hooks
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

---

## Cost Analysis

### Token Costs Per Turn

| Operation | When | Cost |
|---|---|---|
| Noise filter | Every message | 0 tokens (heuristic, no LLM) |
| Classification | Messages passing noise filter | ~200-400 tokens (cheap LLM) |
| Compression | When threshold hit (~every 20 facts) | ~300-600 tokens per batch |
| Injection | Every LLM call | ≤500 tokens added to context |

### Real-World Estimate

For a moderately active user (50 messages/day across channels):
- ~30 messages pass noise filter → 30 classification calls
- ~6,000-12,000 tokens/day for classification (~$0.001-$0.012 depending on provider)
- 1-2 compression runs/day → ~600-1,200 tokens (~$0.001)
- Injection: 500 tokens × ~50 turns = 25,000 tokens → context cost increase (~$0.004)
- **Total overhead: ~$0.01-0.02/day** — negligible

### Cost Savings vs. Alternatives

| Approach | Extra tokens/turn | Monthly cost (active user) |
|---|---|---|
| Merge all contexts | +10,000-50,000 | $15-75 |
| Broadcast raw messages | +2,000-10,000 | $3-15 |
| **Knowledge DAG (this)** | **+500 (bounded)** | **$0.30-0.60** |

---

## Design Decisions & Trade-offs

### 1. LLM Classification vs. Rule-Based Extraction
**Chose:** Cheap LLM (configurable provider) with heuristic pre-filter.
**Why:** Rule-based extraction would miss nuance ("My dentist appointment got pushed back" → schedule change). The noise filter handles obvious rejects for free; the LLM handles semantic understanding. Models under $1/1M input tokens (gpt-4o-mini, gemini-flash-lite) are more than sufficient for structured JSON extraction.
**Trade-off:** Adds ~$0.01/day cost and ~200ms latency per classification. Acceptable given the alternative (missing important facts). Can be eliminated entirely with Ollama (local, free).

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

### 7. Plugin vs. Core Modification
**Chose:** External OpenClaw plugin.
**Why:** Survives upstream updates. Easy to install/remove. Uses public plugin API, not internal modifications.
**Trade-off:** Limited to what the plugin API exposes. Can't modify session context directly — works around this by injecting via `before_prompt_build`.

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

The total cost overhead is about **$0.01-0.02/day** for a moderately active user. That's the price of cross-session awareness.
