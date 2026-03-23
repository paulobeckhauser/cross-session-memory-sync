# Discussion Questions

## 2.1 — Alternatives to OpenClaw

If I were not using OpenClaw, I would **build a custom host from scratch** in Node.js/TypeScript. Two projects that heavily influence this decision are [IronClaw](https://github.com/nearai/ironclaw) and [Nanobot](https://github.com/HKUDS/nanobot), both Rust reimplementations of OpenClaw that take a stronger stance on security: WASM-based plugin isolation with capability-based permissions, and OS keychain encryption for credentials instead of plaintext JSON files. I would adopt these design patterns while keeping TypeScript as the implementation language. The main trade-off is giving up OpenClaw's 22+ built-in channel adapters, meaning I would need to build and maintain only the specific channels my use case requires.

### Comparison: custom host vs. OpenClaw

**Extensibility and plugin ecosystem.** OpenClaw's existing plugin ecosystem is a genuine strength: there are ready-made plugins for common tasks. The problem is that all plugins run unsandboxed in the same Node.js process, giving any plugin full filesystem and network access with no permission model. A single compromised plugin can exfiltrate every API key on the system. With a custom host, I would design plugin isolation from day one using WASM components or Node.js worker threads with capability-based permissions. This does not prevent running third-party plugins; it simply means each plugin must declare what it needs (network access, file reads, secret access) and the host grants only those capabilities. The ecosystem would start smaller, but it could grow safely because sandboxing makes it possible to run untrusted plugins without giving them full system access.

**Multi-channel messaging support.** OpenClaw's 22+ built-in channel adapters are its strongest feature and the main reason to use it. Building from scratch means giving that up. I would implement only the channels I actually need (e.g., Telegram, Slack, WhatsApp). This requires significant effort per channel (auth flows, webhook handling, message formatting, retry logic), but in return I get full control over each integration and a smaller attack surface with no dead code for channels I never use.

**Local-first vs. cloud-first trade-offs.** Both OpenClaw and my custom host would be local-first. The difference is security posture. OpenClaw stores API keys in plaintext JSON (`auth-profiles.json`) and uses flat Markdown for memory (`memory.md`). Taking cues from IronClaw, I would use OS keychain integration for credential encryption and keep the Knowledge DAG on SQLite, which already works and fits a local-first system that prioritizes simplicity. If semantic retrieval proves valuable later, PostgreSQL + pgvector is an upgrade path, but SQLite is a very good starting point.

**Community maturity and long-term viability.** It would mean no community and full ownership of maintenance. This is both the biggest risk (no shared adapter maintenance, no external contributors) and the biggest advantage (no upstream breaking changes from a pre-1.0 API, no dependency on a project that could be abandoned).

---

## 2.2 — Advantages and Disadvantages of OpenClaw

### Advantages

**Channel-agnostic core with adapter pattern.** OpenClaw's most valuable architectural decision is separating the agent runtime from channel-specific logic. This is why 22+ channels work out of the box, and why my sync plugin can hook into the agent lifecycle once and automatically work across all channels without any channel-specific code.

**Plugin hook system.** The event-based hook API (`before_prompt_build`, `llm_input`, `llm_output`) gives plugins access to the right moments in the agent lifecycle without requiring core modifications.

**Local-first data model.** All data lives on the user's machine.

**LLM-agnostic design.** No vendor lock-in.

### Disadvantages

**No plugin sandboxing.** All plugins run unsandboxed in the same Node.js process with full filesystem and network access. There is no permission model. A single compromised or malicious plugin can read every API key, access every file the user owns, and make arbitrary network requests. This is the most serious architectural gap.

**Plaintext credential storage.** API keys are stored in plaintext JSON files (`auth-profiles.json`). A compromised machine exposes everything. Other projects like IronClaw have solved this with OS keychain integration, showing it is not an inherent limitation of the local-first model.

**No structured memory abstraction.** `memory.md` is a flat Markdown file with no schema, indexing, or conflict resolution. This is exactly the gap the sync layer fills. A built-in structured memory layer (even a simple key-value store with timestamps) would have made the cross-session problem easier to solve within OpenClaw's existing primitives.

### Risks of relying on OpenClaw

**Licensing.** OpenClaw is MIT-licensed, so there are no copyleft concerns. Risk is low from a legal perspective.

**Community governance.** OpenClaw is community-driven with no corporate backing. If core maintainers step away, the project could stall.

**Security.** A local agent with access to 22 channels and an unsandboxed plugin system creates a wide attack surface. By default, OpenClaw stores API keys as plaintext JSON in `auth-profiles.json` with no native encryption at rest (filesystem permissions and full-disk encryption are the recommended mitigations). An optional SecretRef system can pull credentials from external tools like 1Password or HashiCorp Vault, but most users never configure it. Combined with the lack of plugin sandboxing, a compromised machine or a malicious plugin could expose all stored credentials.

### "No vector DB, no orchestration framework" philosophy

**How it helps:** it keeps the system simple. The sync layer is ~1,500 lines of TypeScript with one dependency (SQLite).

**How it hinders:** because OpenClaw provides no vector search or semantic retrieval as a built-in primitive, any plugin that needs to find information by meaning (not just by time) must either build that capability from scratch or fall back to simpler strategies like recency.

---

## 2.3 — Maintaining a Custom Fork

The sync layer is an **external plugin**, not a fork. This minimizes coupling to OpenClaw internals. Even so, plugins depend on the host API, so a concrete maintenance strategy is needed.

### Keeping compatible with upstream releases

**Multi-version CI matrix with GitHub Actions.** A weekly scheduled workflow (`cron: '0 6 * * 1'`) runs the full test suite against three OpenClaw versions: current stable, latest release, and the `main` branch (nightly). Testing against `main` provides early warning of breaking changes before they are officially released. If the nightly build fails, I open a compatibility branch (`compat/openclaw-vX.Y`) to prepare adapter fixes before the release lands.

**Integration tests as the API contract.** The adapter tests (`integration.test.ts`) verify the exact API surface the plugin depends on: `api.on()`, `api.registerService()`, `api.logger`, `api.pluginConfig`, and `api.config`. For example, if OpenClaw v0.9 renames `api.on()` to `api.subscribe()`, the test suite fails immediately on the next CI run, pinpointing the exact breakage.

**Typed API stubs as compile-time guard.** The adapter defines TypeScript interfaces (`OpenClawPluginApi`, `PluginLogger`, etc.) that mirror the real OpenClaw plugin API. Type mismatches are caught by the compiler before tests even run. This provides a two-layer safety net: types catch structural changes, tests catch behavioral ones.

### Minimizing risk of breaking changes

**Public API only.** The sync layer only uses documented, public APIs and documented hook events (`before_prompt_build`, `llm_input`, `llm_output`). It does not import internal modules, access private methods, or read OpenClaw's database directly. This means internal refactors that preserve the public API surface do not affect the plugin.

**Adapter pattern as isolation layer.** The core library (`core/`) has zero OpenClaw dependencies. All OpenClaw-specific code lives in a single adapter file (`adapters/openclaw/src/index.ts`, ~500 lines). If the plugin API changes dramatically, only this file needs updating. The extraction pipeline, DAG store, compressor, and assembler are completely unaffected.

**Feature flags for graceful degradation.** The plugin respects `extractionEnabled` and `injectionEnabled` config flags. If a specific hook breaks in a new release, that hook can be disabled while the adapter is updated, keeping the rest of the system functional rather than failing entirely.

### Testing compatibility as OpenClaw evolves

The branching strategy reflects this:

- `main`: always stable, always compatible with the latest stable OpenClaw release
- `feat/xxx`: feature branches for new sync layer capabilities
- `compat/openclaw-vX.Y`: short-lived branches created when a new OpenClaw release requires adapter changes, merged back to `main` once tests pass

Release tags include the tested OpenClaw version (e.g., `v1.2.0-oc0.8`) so compatibility is always traceable.

### Contributing upstream vs. maintaining separately

**Contribute upstream** when the feature is generally useful and requires core changes. For example, if OpenClaw added a structured memory API with timestamps and schema support, that would benefit all users and should be proposed as an upstream contribution.

**Maintain separately** when the feature is opinionated or adds dependencies that OpenClaw's philosophy rejects. The Knowledge DAG, LLM-based classification, and hierarchical compression are specific design choices for cross-session sync. They would not make sense as core OpenClaw features. The sync layer currently falls in this category: it is opinionated, well-encapsulated, and does not require any core changes.
