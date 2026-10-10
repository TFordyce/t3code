# Which adapters can carry user MCP servers, by transport?

Research for [TFordyce/t3code#3](https://github.com/TFordyce/t3code/issues/3) (map: [#1](https://github.com/TFordyce/t3code/issues/1)).
Read against `main` at `c77a7b7eeb`. Source pointers are repo-relative unless they are URLs. Third-party SDK claims cite the installed package version.

## Matrix

| Adapter                          | Where `t3-code` is injected today                                                      | stdio                                                                                            | Streamable HTTP                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Claude                           | Agent SDK `mcpServers` → CLI `--mcp-config` (argv)                                     | **Supported** (needs `${VAR}` secret indirection)                                                | **Supported** (same)                                                                                  |
| Codex                            | `thread/start`/`resume`/`fork` `config.mcp_servers` (JSON-RPC)                         | **Supported**                                                                                    | **Supported**                                                                                         |
| Generic ACP / Grok / Antigravity | `session/new` `mcpServers` (stdio bridge to T3)                                        | **Supported** (ACP baseline), unless the agent drops `mcpServers`                                | **Workaround**: wrap in a stdio→HTTP bridge, because native ACP `http` is optional and agents drop it |
| Cursor                           | `@cursor/sdk` `mcpServers` on `Agent.create` _and_ per `send()`                        | **Supported**, but see the native-server replacement bug                                         | **Supported** (same)                                                                                  |
| Muse                             | MSP `session/start`/`resume` `config.mcpServers`                                       | **Supported** (needs the `sessionMcp` capability)                                                | **Supported** (same)                                                                                  |
| OpenCode v1                      | `client.mcp.add` on the per-session spawned server                                     | **Supported** (`type: "local"`) for managed servers. **Unsupported** for an external `serverUrl` | **Supported** (`type: "remote"`) for managed servers. External: T3 skips MCP today                    |
| OpenCode v2                      | `client.mcp.add` per directory, name `t3-code-<thread>`                                | **Supported** (`Mcp.LocalConfig`); approval rule needed                                          | **Supported** (`Mcp.RemoteConfig`); approval rule needed                                              |
| Pi                               | T3 extension file + env vars, with a hand-rolled HTTP client calling `pi.registerTool` | **Workaround**: extension calls `pi.registerMcpServer` (Pi ≥ 0.99); older Pi unsupported         | **Workaround**: same, or the hand-rolled HTTP client on older Pi                                      |

"Workaround" means T3 must add machinery beyond appending an entry to the existing injection path.

## Per adapter

### Claude (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`)

- **Injection:** `claudeMcpQueryOverrides` (~L1004) builds `mcpServers: { "t3-code": { type: "http", url, headers: { Authorization: "${T3_CODE_MCP_AUTHORIZATION}" }, timeout } }`. It puts the real header in the child env through `mcpEnvironment` (L1032, merged at ~L7378).
- **Config shape:** the SDK `McpServerConfig` is a union of stdio `{type?: 'stdio', command, args, env}`, `sse`, `http {url, headers}`, and in-process `sdk` (`@anthropic-ai/claude-agent-sdk` 0.3.x `sdk.d.ts` L1110-1275). Both transports fit the existing `Record<name, config>`.
- **Secrets in argv: yes, unless avoided.** The adapter comment (~L998) says the SDK passes `mcpServers` to the CLI as inline `--mcp-config`, which any local user can read in the process list. Claude expands `${VAR}` in `command`, `args`, `env`, `url`, and `headers` ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). User secrets need the same treatment as `t3-code`: put them in generated child env vars and reference them as `${T3_MCP_…}`. Caveat from the same docs: some credential names, such as `ANTHROPIC_API_KEY`, always read as empty for remote servers.
- **Merge vs replace:** merge. Sessions do not set `strictMcpConfig`. Only the capability probe sets it (`apps/server/src/provider/ClaudeProvider.ts` L238-240). `.mcp.json`, user/local scopes, plugins, and claude.ai connectors still load.
- **Name collisions:** Claude uses the whole entry from the highest-precedence source and never merges fields across scopes (docs). The docs do not say where `--mcp-config` servers rank against local/project/user ones.
- **Approval:** `t3-code` is pre-approved by `allowedTools` wildcard `mcp__t3-code__*` (L958). User servers must stay out of `allowedTools` so they use the normal permission flow.
- **Live status:** `Query.mcpServerStatus()` returns `connected | failed | needs-auth | pending | disabled` per server, with `source` (`sdk.d.ts` L1165, L2835).
- **Hot-reload (out of scope):** `setMcpServers()` exists (L2995).
- **Org policy:** a managed setting can reject non-sdk `--mcp-config` (`sdk.d.ts` ~L8179). Where that is set, user servers fail along with `t3-code`.

### Codex (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`)

- **Injection:** `codexThreadRuntimeParams` (L1299) adds `config.mcp_servers["t3-code"] = { url, http_headers: { Authorization } }` to `thread/start`, `resume`, and `fork`.
- **Config shape** ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)): stdio uses `command, args, env, env_vars, cwd`. Streamable HTTP uses `url, bearer_token_env_var, http_headers, env_http_headers, auth`. Both share `enabled, required, startup_timeout_sec, tool_timeout_sec, enabled_tools, disabled_tools, default_tools_approval_mode`. SSE is not listed.
- **Secrets in argv:** no. Overrides go over the app-server JSON-RPC stdio. Protocol logs redact `*authorization`, `*token`, `*secret`, and `*apikey` keys plus `Bearer …` values (`redactCodexProtocolValue`, L1452). A user secret under a header name like `X-Api-Key` is caught. One under an arbitrary `env` key such as `GITHUB_PAT` is not, so stdio `env` values need redaction too.
- **Merge vs replace:** merge. Overrides layer above `config.toml` (comment at L1293). The layer merge is a **recursive table merge** (`merge_toml_values`, [openai/codex `codex-rs/config/src/merge.rs`](https://github.com/openai/codex/blob/main/codex-rs/config/src/merge.rs)).
- **Name collisions: a hazard.** A T3 server with the same name as a native `[mcp_servers.X]` is deep-merged field by field. A native stdio `X` plus a T3 HTTP `X` gives an entry with both `command` and `url`. T3 must avoid same-name entries, for example by namespacing or detecting collisions through `config/read`.
- **Approval:** the normal Codex flow. T3 already handles `mcpServer/elicitation/request`.
- **Live status:** `mcpServerStatus/list` (L6361).

### Generic ACP, Grok, Antigravity (`packages/provider-acp/src/server/adapter.ts`)

All three go through `makeAcpAdapterV2`: `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts` L238, `packages/provider-grok/src/server/adapter.ts` L71, and `packages/provider-acp-registry`. `AntigravityInstallation.ts` uses `t3-code` only as an ACP `clientInfo.name` (L372), not as MCP config. Antigravity's provider-setup and text-generation runtimes pass `mcpServers: []` (`AntigravityDriver.ts` L297, L439).

- **Injection:** `acpMcpContext` (L681) always sends `t3-code` as a **stdio** server. Its command is `t3 acp-mcp-bridge` (`apps/server/src/mcp/AcpMcpStdioBridge.ts`), with endpoint and credential in the ACP `env` array. The comment there says agents that advertise `http` still drop injected HTTP servers ("codex-acp 1.2.0 and pi-acp both drop them"). An `acp`-type entry (`acpServers`) is also prepared for MCP-over-ACP (`mcpOverAcpBridge.ts`).
- **Config shape:** ACP `McpServer` = stdio `{name, command, args, env: [{name,value}]}` | `{type:"http", name, url, headers: [{name,value}]}` | `sse` | `acp` (`packages/effect-acp/src/_generated/schema-v1.gen.ts` ~L4360). `http` and `sse` are gated by `agentCapabilities.mcpCapabilities.http/sse` (L77).
- **stdio:** supported. It is ACP's required baseline, so append user stdio entries to `servers`.
- **HTTP: workaround.** Native `http` is capability-gated and unreliable, as above. `AcpMcpStdioBridge` is already a generic stdio→streamable-HTTP relay that handles SSE responses, session id, and protocol version. It supports one `Authorization` value only. Generalising it to any URL and header set (passed by env, never argv) gives every ACP agent HTTP servers over stdio.
- **Trap: the `acp` capability path replaces the list.** `sessionMcpServers` (`AcpSessionRuntime.ts` L2225) sends **only** `acpMcpServers` when the agent advertises `mcpCapabilities.acp` and that list is non-empty. User servers must be added to both lists, or they disappear on MCP-over-ACP agents.
- **Agents that drop `mcpServers` entirely:** unsupported. The `acp-mcp-call` terminal fallback is `t3-code`-specific, prompt-driven, and keyed on the T3 tool inventory (`runtimeModel.ts` ~L1055-1110, `provider-core/src/server/orchestrationInstructions.ts` L32). Report these as "unsupported" per agent. The adapter cannot tell drop from success unless the agent reports MCP status.
- **Secrets in argv:** no. `session/new` travels over ACP stdio, and `env` is delivered to the spawned server's environment. Values a user puts in `args` are on the server's own argv, which is the user's choice.
- **Merge vs replace / collisions:** agent-specific. ACP defines session servers as "in addition to" agent config, but enforcement is up to each agent. Unverified for Grok and Antigravity.
- **Live status:** ACP has no standard MCP status call. Only the T3-side check applies.

### Cursor (`packages/provider-cursor/src/server/adapter.ts`)

- **Injection:** `cursorMcpServers` (L204) returns `{ "t3-code": { type: "http", url, headers } }`. It is passed both to `Agent.create` (`makeCursorAgentOptions`, L328) **and** to every `send()` (L2214).
- **Config shape** (`@cursor/sdk` 1.0.35 `dist/cjs/options.d.ts` L21): stdio `{command, args, env, cwd}` | `{type: "http"|"sse", url, headers, auth}`.
- **Secrets in argv:** no. The SDK local executor runs in-process.
- **Merge vs replace: replace, for the run, today.** In the SDK bundle (`dist/cjs/689.js`), a send-level `mcpServers` becomes `mcpServersOverride`. That builds a session MCP lease with `includeProjectMcp: false, includeUserMcp: false, includePluginMcp: false, inlineMcpServers: <override>`. The run sees **only** T3's inline servers. Agent-level `mcpServers` (the executor/workspace lease) merges with project/user/plugin MCP according to `settingSources`. So **T3 already hides users' `~/.cursor/mcp.json` and `.cursor/mcp.json` servers on Cursor turns** whenever `t3-code` is attached. That breaks the map's "alongside native config" rule. Fix: stop passing `mcpServers` on `send()`, or accept replacement deliberately. Read from the minified bundle, so confirm with a live run.
- **Name collisions:** on the agent-level path, inline servers load as a separate loader with an empty prefix. Same-name precedence is unverified.
- **Approval:** inline servers use `ignoreApprovals: true`, which skips Cursor's per-server trust prompt (`mcp-approvals.json`). Tool-call approval still goes through `autoReview`.

### Muse (`packages/provider-muse/src/server/adapter.ts`)

- **Injection:** L1499 sends `config.mcpServers["t3-code"] = { transport: "streamableHttp", mode: "optional", url, headers }` on `session/start` and `session/resume`. This requires the host to grant `sessionMcp` (L1495; requested in `sdk.ts` L82).
- **Config shape** (`@muse-code/sdk` `dist/src/msp.d.ts` L1361): closed union `{transport: "stdio", command, args, env, framing, mode}` | `{transport: "streamableHttp", url, headers, mode}`. "Native MCP servers added only to this session runtime" (L1194), so it merges with native servers.
- **Constraint:** `mode` defaults to `required`, which fails the whole run when a server is unreachable. User servers must be sent as `optional`.
- **Secrets in argv:** no (MSP over stdio).
- **Collisions:** unspecified in the SDK types.

### OpenCode v1 (`packages/provider-opencode/src/server/adapter.ts`)

- **Injection:** `client.mcp.add({ name: "t3-code", config: { type: "remote", url, headers, oauth: false } })` (L976). It runs only when the connection is not `external`.
- **Config shape** (`@opencode-ai/sdk` `McpLocalConfig`): `{type: "local", command: string[], environment, enabled, timeout}` | `{type: "remote", url, headers, oauth}`.
- **Scope:** `connectToOpenCodeServer` spawns one server per session for managed installs (`OpenCodeRuntime.ts` ~L890-930), so runtime `mcp.add` is session-scoped. With `serverUrl` (external), stdio would run on the external host, not the environment host. That breaks the map's "stdio runs on the environment host" rule, and T3 already skips MCP there. Report unsupported. HTTP could work on an external server, but T3 cannot vouch for reachability.
- **Secrets in argv:** no. The config goes over HTTP to the local server. `OPENCODE_CONFIG_CONTENT` (env) is an alternative channel.
- **Merge vs replace:** merge. `mcp.add` adds to the instance alongside `opencode.json` servers. A same-name `add` overrides the native entry in that instance.
- **Approval:** the managed ruleset asks for `*` in supervised modes (L652), so user MCP tools prompt.
- **Live status:** `client.mcp.status` (L1601).

### OpenCode v2 (`packages/provider-opencode/src/server/v2/adapter.ts`)

- **Injection:** `prepareTurn` (L3254) calls `client.mcp.add({ server: "t3-code-<thread>", location: { directory }, config: new Mcp.RemoteConfig(...) })`. It removes the registration on unload or close (L3227).
- **Config shape** (`@opencode/schema` 2.0.23 `dist/mcp.d.ts`): `LocalConfig {command: string[], cwd, environment, timeout, protocol}` | `RemoteConfig {url, headers, oauth, timeout, protocol}`.
- **Scope:** registrations are per **directory**, not per session (L450), and outlive a session on an external server. User servers resolve the same way for every thread in a project, so one registration per directory works, with removal on last close.
- **Constraints:**
  - Server names over 64 characters lose all their tools. `mcp.add` rejects names over 100 (L453).
  - Permission IDs are `<server>_<tool>`. `mcpRules` only deny/allow `t3-code-*` (L473). The supervised `sessionRules` list only `shell`, `edit`, and `external_directory`, so whether an unlisted MCP permission defaults to ask or allow must be checked. User servers likely need an explicit `<server>_*: ask` rule.
  - `supportsMcpTools: false` in the v2 capabilities (L146) contradicts the actual injection. Check that before relying on capability flags for "unsupported" reporting.

### Pi (`packages/provider-pi/src/server/`)

- **Injection:** `materializePiT3McpExtension` writes `pi-t3-mcp-extension.ts`, loaded with `--extension`. The extension reads `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` from env and runs its own streamable-HTTP client, registering each tool as `mcp__t3-code__<tool>` through `pi.registerTool` (`mcpExtensionSource.ts` L296-340). It feature-detects `pi.registerMcpServer` (Pi 0.99+) only to set tool exposure. The comment there says "mcp.json overrides native registrations", so T3 keeps its own client for `t3-code`.
- **Native support:** Pi core speaks stdio and streamable HTTP and rejects SSE. `pi.registerMcpServer(name, config)` adds a server for the current session, using the same shape as an `mcp.json` entry: `command/args/env/cwd` or `url/headers/oauth`, plus `enabled`, `timeout`, and `exposure` ([earendil-works/pi `docs/mcp.md`, `docs/extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)). `env` and `headers` support `${VAR}`.
- **Workaround:** pass user servers to the extension through an env var (JSON). On Pi ≥ 0.99 the extension calls `pi.registerMcpServer` for each one, giving both transports. On older Pi, HTTP could reuse the hand-rolled client; stdio is unsupported.
- **Secrets in argv:** no (env plus extension file). Keep secrets out of the materialized extension source, which is a cached file.
- **Collisions:** file-configured `mcp.json` servers win over extension-registered ones with the same name. This is safe, but a colliding T3 server is silently shadowed. Report it as "shadowed by native config".
- **Live status:** `pi mcp list` and `/mcp` exist, but no RPC status is wired.

## Cross-cutting constraints

1. **Argv exposure exists only on Claude.** Every other path is stdio JSON-RPC, HTTP, in-process, or env. Claude needs `${VAR}` indirection for every secret-bearing field (`env`, `headers`, and possibly `args`/`url`).
2. **Same-name collisions behave three different ways:** deep field merge (Codex), whole-entry precedence (Claude, Pi with native winning), and unknown (Cursor, Muse, ACP agents). A collision rule enforced by T3, such as a namespaced wire name or refusing names that collide, is safer than relying on any one provider.
3. **`t3-code` must stay reserved on the wire as well as in settings.** OpenCode v2 already uses `t3-code-<thread>`, and its deny rule `t3-code-*` would also block a user server named `t3-code-foo`. Reserve the `t3-code` prefix.
4. **HTTP on ACP needs a bridge.** The generalised `acp-mcp-bridge` is the single piece of new machinery needed for every ACP agent (generic, Grok, Antigravity, registry agents).
5. **Failure posture:** Muse defaults `required`, which fails the run; send `optional`. Codex has `required` (default false). The others are non-fatal.
6. **Existing bug to fix independently:** Cursor's per-`send()` `mcpServers` replaces the user's native Cursor MCP servers for the run.
7. **Remote and external hosts:** stdio runs where the provider process runs. That is the environment host for every adapter except OpenCode with an external `serverUrl`.
8. **Live per-session status is available on Claude** (`mcpServerStatus`), **Codex** (`mcpServerStatus/list`), and **OpenCode** (`mcp.status`). It is not wired for ACP, Cursor, Muse, or Pi.

## Open / unverified

- Claude: where `--mcp-config` (dynamic) servers rank against same-name local/project/user servers.
- Whether Grok's and Antigravity's ACP agents honour session `mcpServers` for non-T3 servers and expose their tools.
- OpenCode v2: the default permission action for MCP tools not covered by `sessionRules`.
- Cursor: the replacement behaviour, read from the minified SDK 1.0.35 bundle, still needs one live confirmation.
