# Cross-Session Memory Sync

Cross-session knowledge synchronization for AI agent frameworks. Enables selective propagation of meaningful knowledge between independent conversation sessions using a shared Knowledge DAG with hierarchical compression.

## Deliverables

| Deliverable | File | Description |
|---|---|---|
| **Architecture document** | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Approach, diagrams, conflict resolution, cost analysis, design trade-offs |
| **Discussion answers** | [`DISCUSSION.md`](DISCUSSION.md) | Parts 2.1 (alternatives), 2.2 (OpenClaw analysis), 2.3 (fork maintenance) |
| **Working solution** | [`core/`](core/) + [`adapters/openclaw/`](adapters/openclaw/) | Framework-agnostic library + OpenClaw plugin |
| **Tests** | [`core/test/`](core/test/) + [`adapters/openclaw/test/`](adapters/openclaw/test/) | 51 tests — cross-session sync, conflict resolution, noise filtering, compression |
| **Setup & run guide** | This file | Prerequisites, installation, configuration, smoke test |

## Architecture

```
core/                    # Framework-agnostic library
├── src/
│   ├── dag-store.ts     # SQLite Knowledge DAG storage
│   ├── compressor.ts    # Hierarchical compression (d0→d1→d2→...dN)
│   ├── assembler.ts     # Token-bounded context assembly
│   ├── extractor.ts     # Fact extraction with conflict detection
│   ├── classifier.ts    # LLM-based fact classifier
│   ├── noise-filter.ts  # Heuristic pre-filter
│   ├── engine.ts        # SyncEngine orchestrator
│   └── types.ts         # Shared types
└── test/                # 44 tests

adapters/openclaw/       # @openclaw/cross-session-sync plugin
├── src/index.ts         # Wires core into OpenClaw hooks
└── openclaw.plugin.json # Plugin manifest
```

## Prerequisites

**Node.js (>= 18)** or **Bun (>= 1.0)** — either works.

### Option A: Node.js (recommended for compatibility)

```bash
# Install Node.js if not already installed
# https://nodejs.org or via nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
```

### Option B: Bun (faster)

```bash
sudo apt-get install -y unzip  # required on some Linux distros
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

## Setup

```bash
git clone git@github.com:paulobeckhauser/cross-session-memory-sync.git
cd cross-session-memory-sync/core
```

### With Node.js / npm

```bash
npm install
npm test

# Build
npx tsc
```

### With Bun

```bash
bun install
bun test

# Build
bun run build
```

### Build OpenClaw adapter

```bash
cd ../adapters/openclaw
npm install   # or: bun install
npm run build # or: bun run build
```

## Running Tests

```bash
cd core
npm test       # Node.js + vitest
# or
bun test       # Bun runtime
```

## OpenClaw Integration

### 1. Enable internal hooks

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "hooks": {
    "internal": {
      "enabled": true
    }
  }
}
```

This is required for plugin hooks to dispatch events.

### 2. Set up LLM provider

The classifier supports multiple LLM providers. By default it uses OpenAI (`gpt-4o-mini`), but you can switch to any provider:

| Provider | Model (default) | Env var | Cost |
|---|---|---|---|
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` | $0.15/1M tokens |
| `anthropic` | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` | $0.80/1M tokens |
| `gemini` | `gemini-2.0-flash-lite` | `GEMINI_API_KEY` | $0.075/1M tokens |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` | $0.14/1M tokens |
| `mistral` | `mistral-small-latest` | `MISTRAL_API_KEY` | $0.10/1M tokens |
| `groq` | `llama-3.1-8b-instant` | `GROQ_API_KEY` | Free tier available |
| `ollama` | `phi3:mini` | *(none needed)* | **Free (local)** |

Set the API key for your chosen provider as an environment variable, or use OpenClaw's built-in auth:

```bash
openclaw auth add openai   # or set OPENAI_API_KEY env var
```

### 3. Install the plugin

```bash
openclaw plugins install ./adapters/openclaw
```

### 4. Configure

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

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

### 5. Restart gateway

```bash
openclaw gateway restart
openclaw plugins list | grep cross-session
```

The plugin should show status **loaded**.

### 6. Smoke test

Send a message on one channel (e.g., Telegram):

> "My dog's name is Bidu"

Then on another channel (e.g., Discord), send `/new` to reset the session and ask:

> "What's my dog's name?"

The assistant should surface "Bidu" from cross-session context.

You can verify facts are being stored:

```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite \
  "SELECT content, category, source_channel, created_at FROM dag_nodes ORDER BY created_at DESC LIMIT 10;"
```

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `classifierProvider` | `openai` | LLM provider: `openai`, `anthropic`, `gemini`, `deepseek`, `mistral`, `groq`, `ollama` |
| `classifierModel` | *(per provider)* | Model name override (each provider has a sensible default) |
| `classifierBaseUrl` | *(per provider)* | Custom API base URL (for self-hosted or proxy setups) |
| `classifierApiKey` | *(auto-resolved)* | Explicit API key (overrides env var and auth profiles) |
| `extractionEnabled` | `true` | Enable/disable fact extraction |
| `injectionEnabled` | `true` | Enable/disable context injection |
| `compressionThreshold` | `20` | d0 facts before compression triggers |
| `maxInjectedTokens` | `500` | Max tokens injected per turn |
| `relevanceWindowHours` | `24` | How far back to look for facts |

## How It Works

1. **Extract** — On each incoming message (`llm_input` + `llm_output` hooks), a noise filter + LLM classifier (configurable provider — OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, or local Ollama) decides if the conversation contains shareable knowledge
2. **Store** — Facts enter the Knowledge DAG as d0 leaf nodes in SQLite
3. **Compress** — When d0 nodes exceed a threshold, they compress into d1 summaries; d1 into d2, recursively
4. **Assemble** — Before each agent turn (`agent:bootstrap` hook), recent d0 facts + compressed d1/d2 summaries are assembled into a token-bounded context block
5. **Inject** — The context block is injected as a bootstrap file into the agent's system prompt

Coexists with Lossless Claw (LCM) — uses plugin hooks, not the exclusive ContextEngine slot.

## Troubleshooting

**Plugin shows "error" status:**
- Ensure `hooks.internal.enabled` is `true` in your OpenClaw config

**No facts extracted:**
- Check that the API key for your chosen provider is set (env var or OpenClaw auth profiles)
- Check gateway logs: `journalctl --user -u openclaw-gateway -f | grep cross-session`

**Facts extracted but not injected:**
- Send `/new` on the target channel to start a fresh session (bootstrap hook fires on new sessions)
- Verify facts exist: `sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "SELECT * FROM dag_nodes;"`

**Clear all stored facts:**
```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "DELETE FROM dag_nodes; DELETE FROM dag_lineage;"
```
