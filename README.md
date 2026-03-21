# Cross-Session Memory Sync

Cross-session knowledge synchronization for AI agent frameworks. Enables selective propagation of meaningful knowledge between independent conversation sessions using a shared Knowledge DAG with LCM-inspired hierarchical compression.

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

### 2. Set up OpenAI API key

The classifier uses the OpenAI API (default model: `gpt-4o-mini`). The plugin resolves the API key automatically from:

1. `OPENAI_API_KEY` environment variable, or
2. OpenClaw auth profiles (`~/.openclaw/agents/main/agent/auth-profiles.json`)

If using OpenClaw's built-in auth, set it up via:

```bash
openclaw auth add openai
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
| `classifierModel` | `gpt-4o-mini` | OpenAI model for fact extraction |
| `extractionEnabled` | `true` | Enable/disable fact extraction |
| `injectionEnabled` | `true` | Enable/disable context injection |
| `compressionThreshold` | `20` | d0 facts before compression triggers |
| `maxInjectedTokens` | `500` | Max tokens injected per turn |
| `relevanceWindowHours` | `24` | How far back to look for facts |

## How It Works

1. **Extract** — On each incoming message (`message:preprocessed` hook), a noise filter + LLM classifier (gpt-4o-mini via OpenAI API) decides if the conversation contains shareable knowledge
2. **Store** — Facts enter the Knowledge DAG as d0 leaf nodes in SQLite
3. **Compress** — When d0 nodes exceed a threshold, they compress into d1 summaries; d1 into d2, recursively
4. **Assemble** — Before each agent turn (`agent:bootstrap` hook), recent d0 facts + compressed d1/d2 summaries are assembled into a token-bounded context block
5. **Inject** — The context block is injected as a bootstrap file into the agent's system prompt

Coexists with Lossless Claw (LCM) — uses plugin hooks, not the exclusive ContextEngine slot.

## Troubleshooting

**Plugin shows "error" status:**
- Ensure `hooks.internal.enabled` is `true` in your OpenClaw config

**No facts extracted:**
- Check that `OPENAI_API_KEY` is set or OpenClaw auth profiles contain an OpenAI key
- Check gateway logs: `journalctl --user -u openclaw-gateway -f | grep cross-session`

**Facts extracted but not injected:**
- Send `/new` on the target channel to start a fresh session (bootstrap hook fires on new sessions)
- Verify facts exist: `sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "SELECT * FROM dag_nodes;"`

**Clear all stored facts:**
```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "DELETE FROM dag_nodes; DELETE FROM dag_lineage;"
```
