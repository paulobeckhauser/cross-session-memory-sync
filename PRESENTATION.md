# Presentation Notes: Cross-Session Memory Sync

## The Problem

OpenClaw sessions share a `memory.md` file on disk, but each session has its own conversation context. If you tell WhatsApp "meeting moved to Thursday", Slack has no idea. The user repeats themselves, the assistant feels broken.

Naive fix (merge all contexts) doesn't work — explodes token costs and hits context window limits.

**Goal:** share relevant knowledge between sessions in near real-time, cheaply, without a unified context.

---

## Architecture

```
  WhatsApp              Slack               Telegram
      |                   |                    |
┌─────┼───────────────────┼────────────────────┼─────┐
│     v                   v                    v     │
│  Hook: llm_input / llm_output (capture)            │
│     |                   |                    |     │
│  Noise Filter → Classify (cheap LLM) → Conflict   │
│     |                   |                    |     │
│     └───────────────────┼────────────────────┘     │
│                         v                          │
│          +==============================+          │
│          ||   Knowledge Tree (SQLite)  ||          │
│          ||  d0: raw facts             ||          │
│          ||  d1: summaries             ||          │
│          ||  d2: meta-summaries        ||          │
│          ||  d3: high-level themes     ||          │
│          ||  d4: core identity         ||          │
│          +==============================+          │
│                         |                          │
│                  before_prompt_build                │
│          ┌──────────────┼──────────────┐           │
│          v              v              v           │
│     Inject ≤500    Inject ≤500    Inject ≤500      │
│     tokens         tokens         tokens           │
└──────────┼──────────────┼──────────────┼───────────┘
           v              v              v
      WhatsApp sees   Slack sees    Telegram sees
      other channels  other channels other channels
```

---

## Extraction Pipeline

1. **Noise Filter** — heuristic, zero tokens
   - Rejects empty, emoji-only, pattern noise ("ok", "lol")
   - Blocks ~60-70% of messages

2. **LLM Classifier** — cheap model, ~200-400 tokens
   - Returns JSON nuggets: fact, category, confidence
   - 6 categories (each compresses independently):
     - **schedule** — meetings, appointments, deadlines
     - **preference** — dark mode, favorite tools, likes/dislikes
     - **decision** — choices made ("going with React", "chose plan B")
     - **fact** — general info ("dog named Bidu", "lives in São Paulo")
     - **relationship** — people connections ("Bob is my manager")
     - **task** — to-dos, action items
   - Confidence < 0.6 = discarded
   - 7 providers supported (OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, Ollama)

3. **Conflict Detection**
   - Word overlap analysis (30% same-category, 60% cross-category)
   - Last-write-wins with `superseded_by` pointers (old facts kept for audit)

4. **Store as d0 fact** in Knowledge Tree

All async — never blocks the conversation. Sync is **near real-time**: facts are available to other sessions on their next LLM call (seconds, not minutes).

---

## Knowledge Tree & Compression

> **Why "Tree" and not "DAG"?**
> In a **tree**, each node has exactly one parent. In a **DAG** (Directed Acyclic Graph), a node can have multiple parents. Our structure is a tree — each d0 fact compresses into exactly one d1 summary.
>
> A DAG would be better because facts can belong to multiple categories. Example: "Meeting with dentist Friday at 3pm" is both **schedule** and **fact**. In a tree, we must pick one category. In a DAG, this fact could feed into both a schedule summary and a health/personal summary — richer context, less information loss.
>
> Current approach works fine for the project scope, but a DAG is a natural next step.

**Table schema (`dag_nodes`):**
| Column | Purpose |
|---|---|
| `id` | unique identifier |
| `depth` | 0 = raw fact, 1+ = summary |
| `content` | the fact or summary text |
| `category` | schedule, preference, decision, fact, relationship, task |
| `confidence` | LLM confidence score (0–1) |
| `source_session` | which session created it |
| `source_channel` | which channel (discord, telegram, etc.) |
| `parent_id` | points to parent summary after compression |
| `created_at` | timestamp |
| `superseded_by` | points to newer conflicting fact (conflict resolution) |
| `is_compressed` | 1 = folded into a summary, excluded from injection |
| `archived_at` | soft-delete timestamp, never hard-deleted |

**Problem:** raw facts accumulate. Can't inject thousands.

**Solution:** hierarchical compression per category:

```
d4: core identity        ← 5+ d3 themes
d3: high-level themes    ← 5+ d2 meta-summaries
d2: meta-summaries       ← 10+ d1 summaries
d1: summaries            ← 20+ d0 facts
d0: raw facts            ← extracted from conversations
```

Default `maxDepth` is 4 (d0–d4, 5 levels), configurable.

Why per-category? Mixing "meeting Monday" with "dog named Bidu" = incoherent summaries.

Fallback: if LLM fails → retry with 50% → deterministic join with ";".

---

## Demo

**Video:**  — https://youtu.be/hsva41IljAU

**Verify:**
```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite \
  "SELECT content, category, source_channel FROM dag_nodes ORDER BY created_at DESC LIMIT 5;"
```

---

## Cost

| Operation | Cost |
|---|---|
| Noise filter | 0 (heuristic) |
| Classification | ~200-400 tokens |
| Compression | ~300-600 tokens/batch |
| Injection | ≤500 tokens/turn |

**Active user (50 msgs/day): $0.01-0.02/day (~$0.30-0.60/month)**

vs. naive alternatives: 50-250x cheaper.

---

## Trade-offs & Limitations

**Deliberate choices:**
- LLM classification over rules → catches nuance
- SQLite over Postgres → local-first, zero config
- Last-write-wins over CRDTs → simple, sufficient
- Fixed budget over semantic retrieval → predictable cost

**Known limitations:**
- No channel privacy filtering (P0)
- English-only conflict detection (P1)
- 500-token budget can drop facts at scale with 5+ channels (P2)
- No retrieval — injection is recency-based, not relevance-based (P2). All active facts are dumped until the budget is full. Works for 2-3 channels, but at scale a scheduling question gets injected with unrelated preferences just because they're newer. Semantic retrieval (vector search or LLM relevance scoring) would be a natural next step, at the cost of added complexity

**Discovered during testing — word overlap loses detail (P1):**
Last-write-wins with word overlap can replace a detailed fact with a vaguer one. Example from live testing: "My dentist appointment is on Friday, March 27 at 16:00" was superseded by "My dentist is on Friday" — the newer fact matched on "dentist" + "Friday" (>30% overlap), but lost the specific date and time. The conflict detector doesn't understand meaning, it just counts shared words.

Possible solution: **LLM-assisted conflict resolution** — ask the cheap LLM "is this a correction or a rephrasing? Should it replace or coexist?" (~50 extra tokens, but preserves important details).

**Discovered during testing — stale summaries (P1):**
Conflict detection only checks d0 vs d0. If a fact changes after it was compressed into a d1+ summary, the old summary keeps stale info. Example: d1 says "interview on Thursday", user corrects to Friday → new d0 is created but old d1 still says Thursday. Both get injected.

Possible solutions:
1. **Conflict check against summaries** — when a new d0 arrives, also scan d1+ content for overlap. If conflict found, mark the summary for re-compression
2. **Summary expiration** — give summaries a TTL (e.g. 7 days). Expired summaries get rebuilt from their surviving source facts + any new d0s
3. **LLM-assisted invalidation** — ask the cheap LLM "does this new fact contradict this summary?" (~50 extra tokens per check, but more accurate than word overlap)

---

## Why a Plugin, Not a Fork

- **Lower maintenance** — no merge conflicts with upstream, just track the public API
- **Follows OpenClaw's philosophy** — no vector DB, no orchestration framework. We use SQLite (local-first) and simple heuristics instead of heavyweight infra
- Uses only public API: `api.on()`, `api.registerService()`, `api.logger`, `api.pluginConfig`
- Core library has zero OpenClaw dependencies — portable to other frameworks
- If OpenClaw disappears: only the ~500-line adapter needs replacing

## Maintenance

- GitHub Actions workflow runs tests weekly against 3 OpenClaw versions (stable + latest + nightly)
- TypeScript interfaces mirror plugin API (compile-time guard)
- Integration tests verify the exact API surface
- Contribute upstream when it benefits the community; keep separate when it's too specific

---

## Discussion Talking Points

**If not OpenClaw, what?** Custom Node.js host inspired by IronClaw/Nanobot (Rust reimplementations). Key difference: WASM plugin sandboxing + OS keychain for credentials. Trade-off: lose 22+ built-in channel adapters, but gain security and full control.

**OpenClaw strengths:**
- Channel-agnostic adapter pattern — why 22+ channels work and why the plugin works across all of them with zero channel-specific code
- Hook system (`before_prompt_build`, `llm_input`, `llm_output`) — right access points without core changes
- Local-first, LLM-agnostic

**OpenClaw weaknesses:**
- No plugin sandboxing — any plugin gets full filesystem/network access, can exfiltrate API keys
- Plaintext credential storage (`auth-profiles.json`) — IronClaw solved this with OS keychain
- No structured memory abstraction — `memory.md` is flat Markdown with no schema, indexing, or conflict resolution. This is exactly the gap the sync layer fills

**"No vector DB" philosophy:**
- Helps: keeps system simple (~1,500 lines, one dependency)
- Hinders: no semantic retrieval built-in, must fall back to recency-based heuristics
