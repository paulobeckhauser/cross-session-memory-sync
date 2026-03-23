# Cross-Session Memory Sync

Cross-session knowledge synchronization for AI agent frameworks. Enables selective propagation of meaningful knowledge between independent conversation sessions using a shared Knowledge DAG with hierarchical compression.

## Deliverables

| Deliverable | File | Description |
|---|---|---|
| **Architecture document** | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Approach, diagrams, conflict resolution, cost analysis, design trade-offs |
| **Discussion answers** | [`DISCUSSION.md`](DISCUSSION.md) | Parts 2.1 (alternatives), 2.2 (OpenClaw analysis), 2.3 (fork maintenance) |
| **Working solution** | [`core/`](core/) + [`adapters/openclaw/`](adapters/openclaw/) | Framework-agnostic library + OpenClaw plugin |
| **Tests** | [`core/test/`](core/test/) + [`adapters/openclaw/test/`](adapters/openclaw/test/) | 69 tests — cross-session sync, conflict resolution, noise filtering, compression, stress tests |
| **Demo video** | [Cross-Session Memory Sync — Demo](https://youtu.be/hsva41IljAU?si=HMc2coIQHoCKzNXv) | End-to-end demonstration of cross-session fact extraction and injection |
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

- **OpenClaw** — already installed and running (`openclaw gateway status` should show `running`)
- **Node.js (>= 18)** or **Bun (>= 1.0)**
- **C/C++ build tools** — `better-sqlite3` is a native module that compiles from source

### Install build tools (if missing)

```bash
# Debian/Ubuntu
sudo apt-get install -y build-essential python3

# macOS (Xcode command line tools)
xcode-select --install
```

Without `gcc`/`make`, `npm install` will fail on `better-sqlite3` with a confusing `node-gyp` error.

### Install Node.js (if missing)

```bash
# via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22

# or via Bun (faster, but less compatible)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

## Quick Start (build + install + run)

```bash
# 1. Clone
git clone git@github.com:paulobeckhauser/cross-session-memory-sync.git
cd cross-session-memory-sync

# 2. Build core library
cd core
npm install
npx tsc
cd ..

# 3. Build OpenClaw adapter
cd adapters/openclaw
npm install
npm run build
cd ../..

# 4. Install plugin into OpenClaw
cd adapters/openclaw
openclaw plugins install .
cd ../..

# 5. Run tests (optional, but recommended to verify the build)
cd core && npm test && cd ..
```

## OpenClaw Configuration

You need to edit `~/.openclaw/openclaw.json`. The following three changes are required.

### 1. Enable internal hooks

Find (or add) the `hooks` key at the top level:

```json
{
  "hooks": {
    "internal": {
      "enabled": true
    }
  }
}
```

**This is not enabled by default.** Without it, the plugin loads but hooks never fire — facts won't be extracted or injected (silent failure, no errors in logs).

### 2. Enable the plugin

Add `cross-session-sync` to the `plugins.entries` object:

```json
{
  "plugins": {
    "entries": {
      "cross-session-sync": {
        "enabled": true,
        "config": {
          "classifierProvider": "openai",
          "classifierModel": "gpt-4o-mini"
        }
      }
    }
  }
}
```

**Do NOT add `cross-session-sync` to `plugins.allow`.** The `allow` array only accepts stock plugin IDs. Adding a custom plugin ID there will crash the gateway on restart with `plugins.allow: plugin not found: cross-session-sync`.

### 3. Set up LLM provider

The classifier needs an LLM to decide which conversation facts are worth persisting. Pick one:

| Provider | Model (default) | Env var | Cost |
|---|---|---|---|
| `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` | $0.15/1M tokens |
| `anthropic` | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` | $0.80/1M tokens |
| `gemini` | `gemini-2.0-flash-lite` | `GEMINI_API_KEY` | $0.075/1M tokens |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` | $0.14/1M tokens |
| `mistral` | `mistral-small-latest` | `MISTRAL_API_KEY` | $0.10/1M tokens |
| `groq` | `llama-3.1-8b-instant` | `GROQ_API_KEY` | Free tier available |
| `ollama` | `phi3:mini` | *(none needed)* | **Free (local)** |

Set the key as an env var, or use OpenClaw auth profiles:

```bash
export OPENAI_API_KEY="sk-..."
# or:
openclaw auth add openai
```

If the gateway runs as a systemd service, env vars in your shell won't reach it. Either use `openclaw auth add` (persisted to config) or add the env var to the service file.

### 4. Restart gateway and verify

```bash
openclaw gateway restart
openclaw plugins list | grep cross-session
```

The plugin should show status **loaded**. If it doesn't appear at all, check the logs:

```bash
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep cross-session | tail -20
```

## Smoke Test

**Channel A** (e.g., Telegram) — send:

> My dog's name is Bidu

**Channel B** (e.g., Discord) — send `/new` to reset the session, then ask:

> What's my dog's name?

The assistant should answer "Bidu" from cross-session context.

Verify facts in the database:

```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite \
  "SELECT content, category, source_channel, created_at FROM dag_nodes ORDER BY created_at DESC LIMIT 10;"
```

## Running Tests

```bash
cd core
npm test       # Node.js + vitest
# or
bun test       # Bun runtime
```

### Test strategy: unit tests vs. live channel tests

The automated test suite (69 tests across 7 files) validates the **core sync logic** — extraction, conflict detection, noise filtering, compression, and context assembly — using mock classifiers and a real SQLite database. Channels like `"telegram"` and `"discord"` appear as string labels in these tests; no real messaging platform is involved.

This is intentional. True end-to-end channel tests would require a running OpenClaw gateway, configured bot credentials for each platform (Telegram bot token, Discord bot, etc.), and sending real messages through real APIs. These are fragile, slow, credential-dependent, and impossible to run in CI without infrastructure — so they are covered as **manual smoke tests** instead.

**Automated tests prove:**
- Facts propagate between session keys (different channels)
- Conflicting facts get superseded (last-write-wins)
- Noise messages are filtered and never stored
- Compression triggers at the right thresholds
- Token budgets are respected during injection
- The OpenClaw adapter registers the correct hooks

**Manual smoke test proves:**
- The full pipeline works through real OpenClaw channels (see [Smoke Test](#smoke-test) above)
- Real LLM classification extracts meaningful facts
- Injected context actually influences the assistant's responses on other channels

Together, the automated suite validates correctness of the logic, and the smoke test validates that the integration with OpenClaw and real channels works end-to-end.

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

## Important Notes

- **Don't move or delete the cloned repo after install.** OpenClaw resolves the plugin from its original `sourcePath`, not a copy. If you move the repo, the plugin stops loading.
- **The `plugins.allow` array is only for stock plugins.** Adding `cross-session-sync` there crashes the gateway. Only add it to `plugins.entries`.
- **`hooks.internal.enabled` defaults to `false`.** This is the most common silent failure — the plugin loads, shows no errors, but does nothing.

## Troubleshooting

**Gateway crashes on restart with `plugins.allow: plugin not found`:**
- You added `cross-session-sync` to the `plugins.allow` array. Remove it — only stock plugin IDs go there. The plugin only needs an entry in `plugins.entries`.

**Plugin not in `openclaw plugins list`:**
- Run `openclaw plugins install .` again from `adapters/openclaw/`
- Check that `plugins.installs.cross-session-sync` exists in `~/.openclaw/openclaw.json`
- Check logs: `cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep cross-session | tail -20`

**Plugin shows "loaded" but nothing happens:**
- Ensure `hooks.internal.enabled` is `true` — without this, hooks never fire
- Check that your LLM API key is set and reachable from the gateway process

**`npm install` fails on `better-sqlite3`:**
- Install build tools: `sudo apt-get install -y build-essential python3`
- On macOS: `xcode-select --install`

**No facts extracted:**
- Check that the API key for your chosen provider is set (env var or `openclaw auth add`)
- If the gateway runs as a systemd service, shell env vars don't reach it — use `openclaw auth add` instead
- Check gateway logs: `cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep cross-session`

**Facts extracted but not injected:**
- Send `/new` on the target channel to start a fresh session (the `before_prompt_build` hook fires on new sessions)
- Verify facts exist: `sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "SELECT * FROM dag_nodes;"`

**Clear all stored facts:**
```bash
sqlite3 ~/.openclaw/memory/cross-session-sync-knowledge-dag.sqlite "DELETE FROM dag_nodes; DELETE FROM dag_lineage;"
```
