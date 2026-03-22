# The Solution, Step by Step

## The Problem (in plain terms)

Imagine you have one AI assistant, but you talk to it on multiple apps — WhatsApp, Slack, Telegram. Each app has its own conversation — its own "memory" of what you've been talking about.

If you tell WhatsApp "My meeting got moved to Thursday," and then ask Slack "When's my meeting?" — Slack has no idea. It never saw that message. The conversations are **isolated**.

The naive fix — dump everything from every conversation into every other conversation — is too expensive. Each word you send to the LLM costs money (tokens). You'd be paying 10x for a 10-channel setup.

## The Core Idea

Instead of sharing **conversations**, share **facts**.

Most of what people say in chat is noise — "ok", "thanks", "lol", "got it". The actual useful information is a tiny fraction: "My meeting is Thursday", "My dog's name is Bidu", "I decided to use PostgreSQL."

So the system does three things:

1. **Listen** to every conversation, extract only the meaningful facts
2. **Store** those facts in a shared database
3. **Inject** relevant facts into other sessions before the LLM sees them

That's it. The rest is engineering to make this efficient, reliable, and bounded.

---

## Step 1: Listening — How facts get extracted

When you send a message on any channel, it goes through a pipeline:

### First gate: Noise Filter (free, no LLM call)

Before spending money on an LLM call, a cheap heuristic filter rejects obvious noise:

- Is the message empty or whitespace? **Reject.**
- Only emojis? **Reject.** (thumbs up, laughing, folded hands)
- Matches a known noise pattern? **Reject.** ("ok", "lol", "thanks", "got it", "sounds good", "yes", "no", "sure", etc.)

No word-count gate — short messages like "allergic penicillin" or "vegan diet" can carry critical facts. The pattern list handles the actual noise.

This filter costs zero tokens. It's just string matching. It blocks ~60-70% of messages from ever reaching the LLM.

### Second gate: LLM Classifier (cheap LLM call)

Messages that survive the noise filter go to a small, cheap LLM. The provider is configurable — OpenAI (`gpt-4o-mini`), Gemini (`flash-lite`), DeepSeek, Mistral, Groq, Anthropic (`haiku`), or even a **local model via Ollama** (zero cost).

**Why cheap models are enough:** The classifier does structured JSON extraction — "is there a personal fact here? output JSON or null." This is pattern recognition with a rigid output format, not creative reasoning. Models under **$1/1M input tokens** (like gpt-4o-mini at $0.15 or gemini-flash-lite at $0.075) perform just as well as expensive ones. Using GPT-4o ($2.50) or Claude Sonnet ($3.00) for this would be wasteful — the system will warn you if you configure a model above the $1/1M ceiling.

| Provider | Default model | Cost/1M input tokens |
|---|---|---|
| Gemini | `gemini-2.0-flash-lite` | $0.075 (cheapest cloud) |
| Mistral | `mistral-small-latest` | $0.10 |
| DeepSeek | `deepseek-chat` | $0.14 |
| OpenAI | `gpt-4o-mini` | $0.15 (default) |
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

### Third gate: Conflict Detection

Before storing a new fact, the system checks: **does this contradict something we already know?**

Say we already have: *"Favorite color is blue"*

And a new fact comes in: *"Favorite color is green"*

The system compares them:
1. Normalize both (lowercase, remove filler words like "is", "my", "the")
2. Check word overlap — "favorite" and "color" appear in both → high overlap
3. Same category (preference) + high overlap → **conflict detected**

When there's a conflict, the old fact gets **superseded** — it's marked as replaced by the new one. Not deleted (we keep it for audit), but hidden from active queries.

**Result: the latest fact wins.** Simple, predictable, matches how humans think ("I changed my mind").

### Storage

The surviving fact gets stored as a **d0 node** (depth 0 = raw fact) in a SQLite database:

```
id:             "abc-123"
depth:          0
content:        "Meeting with Acme Corp moved to Thursday"
category:       "schedule"
confidence:     0.9
source_session: "whatsapp-session-42"
source_channel: "whatsapp"
superseded_by:  null          ← this is the current truth
created_at:     "2026-03-22T10:00:00Z"
```

All of this happens **asynchronously** — it doesn't slow down the user's conversation. The extraction runs in the background after the LLM responds.

---

## Step 2: Storing — The Knowledge DAG

"DAG" stands for Directed Acyclic Graph. But think of it simply as a **tree of facts and summaries**.

### Why not just a flat list of facts?

Because over time, you'd accumulate thousands of facts. You can't inject thousands of facts into every LLM call — that would blow the token budget.

So the system **compresses** old facts into summaries:

```
Layer 0 (raw facts):
  "Meeting Monday 10am"
  "Meeting Wednesday 2pm"
  "Team standup Friday"
  "Dentist appointment Tuesday"
  ... (20 schedule facts)
         |
         v  compression triggers at 20 facts
Layer 1 (summary):
  "User has regular meetings Mon/Wed/Fri and a dentist
   appointment Tuesday"
         |
         v  compression triggers at 10 summaries
Layer 2 (meta-summary):
  "User has a busy weekly schedule with work meetings
   and medical appointments"
```

**When does compression happen?**
- 20 raw facts (d0) in one category → compress to 1 summary (d1)
- 10 summaries (d1) in one category → compress to 1 meta-summary (d2)
- And so on, up to depth 4

**Compression is per-category.** Schedule facts compress with schedule facts. Preferences compress with preferences. This prevents nonsensical summaries mixing "My meeting is Monday" with "My dog's name is Bidu."

**What if the LLM is down during compression?** Three fallback levels:
1. Try compressing all facts
2. Retry with just the most recent 50%
3. Last resort: just join them with semicolons (no LLM needed)

Compression never blocks the system. If it fails, facts stay uncompressed — they'll still be available, just taking more tokens.

---

## Step 3: Injecting — How other sessions see the facts

This is where the magic happens. Before **every** LLM call on **any** channel, the system runs the **assembler**.

### The Assembler

The assembler's job: build a markdown block of cross-session knowledge that fits within a **token budget** (default: 500 tokens).

It does this:

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

The output looks like:

```markdown
## Cross-Session Context

### Recent
- [whatsapp, 5min ago] Meeting with Acme Corp moved to Thursday
- [telegram, 2h ago] Dog's name is Bidu

### Background
- User prefers dark mode and VS Code for development
- PostgreSQL chosen for database; weekly team standups Mon/Wed/Fri
```

This block gets **prepended to the LLM's system prompt**. The assistant sees it as context before processing the user's message.

### Why 500 tokens?

It's a balance:
- **Too few** (100) → misses important context
- **Too many** (2000) → adds cost to every single LLM call across every session
- **500** → roughly 375 words, enough for ~15-20 facts or a mix of facts and summaries
- Cost: ~$0.001 per turn → ~$0.30/month for an active user

---

## How It All Fits Into OpenClaw

The entire system is an **OpenClaw plugin** — no modifications to OpenClaw's core code.

It hooks into three events:

| Hook | When it fires | What we do |
|---|---|---|
| `llm_input` | User sends a message | Capture the user's message |
| `llm_output` | LLM responds | Extract facts from the conversation turn |
| `before_prompt_build` | Before every LLM call | Inject cross-session context |

```
User types on WhatsApp
        |
        v
   [llm_input]  <-- we capture "My meeting moved to Thursday"
        |
        v
   LLM responds "Got it, I'll remember that"
        |
        v
   [llm_output] <-- we extract fact, store in DAG
        |
        v
   ... later, on Slack ...
        |
        v
   [before_prompt_build] <-- we inject "Meeting moved to Thursday"
        |
        v
   LLM sees the fact, can answer "When's my meeting?"
```

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
   |  |(gpt-4o) |   |                 |
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

## Why This Design?

| Decision | Why |
|---|---|
| Extract facts, not forward messages | Noise stays local. Only meaning propagates. |
| SQLite, not Postgres/Redis | OpenClaw is local-first. No external services. |
| Last-write-wins conflicts | Simple, predictable. Matches "I changed my mind." |
| 500-token bounded injection | Fixed cost per turn. Doesn't grow with channels. |
| Hierarchical compression | DAG stays bounded. Old facts don't bloat the budget. |
| Plugin, not core modification | Survives upstream updates. Easy to install/remove. |
| Async extraction | Never slows down the user's conversation. |

The total cost overhead is about **$0.01-0.02/day** for a moderately active user. That's the price of cross-session awareness.
