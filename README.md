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

### 1. Install the plugin

```bash
openclaw plugins install ./adapters/openclaw
```

### 2. Configure

Add to your OpenClaw config:

```yaml
plugins:
  entries:
    cross-session-sync:
      enabled: true
      config:
        classifierModel: "claude-haiku-4-5-20251001"
        extractionEnabled: true
        injectionEnabled: true
        compressionThreshold: 20
        maxInjectedTokens: 500
        relevanceWindowHours: 24
```

### 3. Restart gateway

```bash
openclaw gateway restart
openclaw plugins list | grep cross-session
```

### 4. Smoke test

Send a message on one channel (e.g., Telegram):

> "I have a dentist appointment on Friday at 3pm"

Then on another channel (e.g., Discord), ask:

> "Do I have any appointments this week?"

The assistant should surface the Friday dentist appointment from cross-session context.

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `classifierModel` | `claude-haiku-4-5-20251001` | Model for fact extraction |
| `extractionEnabled` | `true` | Enable/disable fact extraction |
| `injectionEnabled` | `true` | Enable/disable context injection |
| `compressionThreshold` | `20` | d0 facts before compression triggers |
| `maxInjectedTokens` | `500` | Max tokens injected per turn |
| `relevanceWindowHours` | `24` | How far back to look for facts |

## How It Works

1. **Extract** — After each LLM turn, a noise filter + LLM classifier decides if the conversation produced shareable knowledge
2. **Store** — Facts enter the Knowledge DAG as d0 leaf nodes in SQLite
3. **Compress** — When d0 nodes exceed a threshold, they compress into d1 summaries; d1 into d2, recursively
4. **Assemble** — Before each turn, recent d0 facts + compressed d1/d2 summaries are assembled into a token-bounded context block
5. **Inject** — The context block is prepended to the system prompt via `before_prompt_build` hook

Coexists with Lossless Claw (LCM) — uses plugin hooks, not the exclusive ContextEngine slot.
