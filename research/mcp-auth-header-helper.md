# Can Codex, Claude and Pi fetch MCP auth headers from a T3 helper command?

Research for [TFordyce/t3code#14](https://github.com/TFordyce/t3code/issues/14) (map: [#1](https://github.com/TFordyce/t3code/issues/1)).
It builds on `research/mcp-oauth.md` (branch `research/mcp-oauth`, [#10](https://github.com/TFordyce/t3code/issues/10)) and the sign-in keying decision in [#12](https://github.com/TFordyce/t3code/issues/12). It does not repeat them.

Checked on 2026-10-10 against:

- T3 at `origin/main` `375405e10e`;
- Codex `rust-v0.156.1`, the version T3 installs as its managed runtime (`apps/server/src/provider/CodexInstallation.ts` L57-92), plus tags `rust-v0.146.0` to `rust-v0.156.0` to date the feature;
- `@anthropic-ai/claude-agent-sdk` 0.3.276 (bundled `claudeCodeVersion` 2.1.276), the Claude Code 2.1.296 binary, the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) and the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md);
- Pi `earendil-works/pi` `main` at `4ac0bd8c7b` (coding-agent 1.1.0) and tag `v0.99.0`;
- `@muse-code/sdk` 1.4.2.

## Answer

All three can run a helper command, but only Codex and Claude re-run it when the server rejects the header. Pi re-runs it only on reconnect.

T3 does not need a helper for Claude or Pi. Claude already gets refreshed headers through `setMcpServers`, and T3's own Pi extension can re-register the server. The only provider that gains anything is Codex, and Muse has no helper mechanism at all.

**Recommendation: don't ship `t3 mcp-auth-header` in v1.** Ship the server-side piece it would sit on: one service method that returns the current header for `(scope, name)`, refreshing first if needed. T3's stdio bridge needs that method anyway. If the Codex/Muse long-session gap matters before v2, route those providers' OAuth-signed-in servers through the stdio bridge that ACP already needs. That fixes Codex and Muse with one mechanism. A Codex-only helper (shape below) is the fallback.

| Provider   | Helper mechanism                                                            | Our version has it?                                                                                                                           | When it runs                                                                                                                                                                                                                                                      | Inherits T3 env?                                                                                        | Closes the long-session gap?                                                                                                        |
| ---------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Codex**  | `http_headers_helper`: a shell command that prints a JSON object of headers | Yes. Added in 0.148; re-run on 401/403 since 0.152. Managed runtime is 0.156.1. User-supplied Codex binaries older than 0.152 lack the re-run | Once when the MCP client is created (eagerly, then cached). Again **once** after a same-origin POST returns 401/403 (not `insufficient_scope`), and the request is retried only if the headers changed. No timer. 10 s timeout, 64 KiB output                     | **No.** The env is cleared to a fixed allowlist (`HOME`, `PATH`, `USER`… / Windows core vars)           | Yes                                                                                                                                 |
| **Claude** | `headersHelper`: a shell command that prints a JSON object of headers       | Yes, at runtime through SDK `mcpServers` / `--mcp-config`. **Not in the SDK TS type** (`McpHttpServerConfig`), so it needs a cast             | Each connection (session start and reconnect), uncached. On a tool call's 401/403 it re-runs, reconnects and retries once (≥ 2.1.193; fixed for helper-supplied `Authorization` in 2.1.248). 10 s timeout                                                         | **Yes** for SDK/`--mcp-config` servers (credential-like vars are only scrubbed for repo/plugin servers) | Yes, but T3 already gets the same result through `setMcpServers` re-injection ([#10](https://github.com/TFordyce/t3code/issues/10)) |
| **Pi**     | `!command` as a whole header value; stdout is the header value (not JSON)   | Yes, since built-in MCP in 0.99.0 (T3 already needs 0.99+ for user servers)                                                                   | Each time a transport is created: first connect, reconnect after the transport closes, a 404 session-expiry retry, `/mcp` reconnect. Uncached for MCP. **Not re-run on 401**: with a static `Authorization`, Pi has no auth provider and the tool call just fails | Yes (`execSync`, process env)                                                                           | No. T3's in-process Pi extension can re-register the server with a new header instead, which makes Pi reconnect                     |
| **Muse**   | None. `SessionMcpServerConfig` HTTP is `{url, headers, mode}`               | n/a                                                                                                                                           | n/a                                                                                                                                                                                                                                                               | n/a                                                                                                     | Only via a stdio bridge (Muse supports stdio servers with `env`)                                                                    |

## Codex

**Version.** T3's managed Codex is `rust-v0.156.1` (`CodexInstallation.ts`). The `http_headers_helper` key first appears in `codex-rs/config/src/mcp_types.rs` at `rust-v0.148.0` (absent at 0.146.0 and 0.147.0). From 0.148 to 0.151 the helper ran once and was cached for the client's lifetime. The 0.150.0 source says: "No rejection-driven refresh: 401/403 may be OAuth challenges, and reconnecting loses sessions". The rejection-driven refresh (`refresh_epoch`) appears in `rust-v0.152.0`. Users who point T3 at their own older Codex get a helper that never refreshes. Gate on ≥ 0.152.

**Configuration.** It's a field on a streamable-HTTP server entry, next to `url`, `http_headers`, `env_http_headers` and `bearer_token_env_var` ([`mcp_types.rs` L362-364, L483-506 @ rust-v0.156.1](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/mcp_types.rs)):

- It's rejected on stdio, when empty, and for non-local `environment_id` ("only supported for local MCP servers"). `apply_http_headers_helper` in `codex-mcp/src/runtime.rs` also refuses it outside the local environment. "Local" means Codex's own host, which is where T3 always runs it.
- The deserializer is the same `RawMcpServerConfig` whether the entry comes from `config.toml` or app-server per-thread `config` overrides. T3 already sends `mcp_servers.t3-code` through `thread/start|resume|fork` `config` (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` L1300-1329), so `mcp_servers.<name>.http_headers_helper` would travel the same way. Codex's own tests only exercise it through `config.toml` (`app-server/tests/suite/v2/mcp_server_status.rs` L122-177). The thread-override path is not tested live.

**Run semantics** ([`rmcp-client/src/http_headers.rs` @ rust-v0.156.1](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rmcp-client/src/http_headers.rs)):

- `HttpHeadersProvider::new` starts the helper as soon as the HTTP client is built, and caches the result as a shared future. Every same-origin request reuses it.
- `retry_request`: after a same-origin **POST** returns 401, or 403 without an `insufficient_scope` challenge, it calls `refresh(epoch)`. Concurrent rejections share one helper run through `refresh_epoch`. The request is retried once, and only if the helper's values changed. Otherwise the original rejection stands, which keeps OAuth challenges intact.
- A failed refresh keeps the previous cached headers.
- `run_helper`: `sh -c <command>` on Unix, or `%COMSPEC% /Q /D /C "<command>"` on Windows. The helper runs in its own process group / job object, with a 10 s timeout, stdout capped at 64 KiB, stderr discarded, and `cwd` = Codex's local process cwd. Stdout must be a single JSON object of string → string. Reserved headers such as `content-type`, `host` and `mcp-session-id` are refused.
- **Environment:** `.env_clear().envs(create_env_for_mcp_server(None, &[]))`. That is `DEFAULT_ENV_VARS` (`HOME, LOGNAME, PATH, SHELL, USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM, TMPDIR, TZ` on Unix; `WINDOWS_CORE_ENV_VARS` on Windows) plus custom-CA vars ([`rmcp-client/src/utils.rs` L17-56, L162-179](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rmcp-client/src/utils.rs)). **No T3 variable reaches the helper.**
- **Precedence:** an `Authorization` header that is already on the request wins over the helper's. That covers `http_headers`, `bearer_token_env_var` and stored MCP OAuth (`apply_headers`). T3 must therefore not also send `http_headers.Authorization`. The stored-OAuth lookup in `codex-mcp/src/server.rs` (~L150-180) only looks at `http_headers` / `env_http_headers`. So if the user has a **native Codex OAuth login for the same URL** in their keyring, Codex's own token would override T3's helper. That's an edge case, but a real one.
- The config doc comment warns that the command "may be visible to local process inspection; do not embed credentials" (`mcp_types.rs` ~L590).

## Claude

**Does the SDK path accept it?** Yes, at runtime.

- The SDK turns `options.mcpServers` into `--mcp-config <json>` (`sdk.mjs`: `q.push("--mcp-config", me({mcpServers:X}))`).
- The CLI's HTTP/SSE/WS server schema includes `headersHelper` (in `sdk.mjs`, and in the 2.1.296 binary).
- The **TypeScript type** `McpHttpServerConfig` (`sdk.d.ts` L1110-1125) does not declare it. The `headersHelper` fields elsewhere in `sdk.d.ts` (L6982 etc.) belong to plugin-marketplace settings. T3 would have to widen the type locally.
- The docs list "a server from the SDK's `mcpServers` option or `setMcpServers()` method, or `--mcp-config`" explicitly. They run helpers from the session's primary working directory ([MCP docs, "Where the helper runs"](https://code.claude.com/docs/en/mcp)).

**Trust and env.**

- In the binary, `be()` (the MCP helper runner) classifies scope `"dynamic"` (SDK/`--mcp-config`) as `"operator"`. So `isRepoResidentConfig` is false: there's no workspace-trust gate, and `scrubCredentialEnv` is false (`Ee()` only scrubs when there's a plugin, scope `project`, or a non-operator agent source).
- The docs confirm this: "Not removed: … supplied by the SDK or `--mcp-config`" ("Which variables a helper can read").
- The helper therefore inherits the Claude process env. That env already carries `T3_CODE_MCP_AUTHORIZATION` (`ClaudeAdapterV2.ts` L1042-1072, L7458). The helper also gets `CLAUDE_CODE_MCP_SERVER_NAME` and `CLAUDE_CODE_MCP_SERVER_URL`.

**When it runs** (docs: "Use dynamic headers"; changelog):

- "runs the helper fresh on each connection, at session start and on reconnect… doesn't cache the result".
- "If a tool call returns `401` or `403`, Claude Code automatically re-runs the helper…, reconnects with the fresh headers, and retries the call once". Added in **2.1.193**. **2.1.248** fixed helper-supplied `Authorization` falling into OAuth discovery on a 401 instead of re-running.
- A helper-supplied `Authorization` disables OAuth fallback. A rejection at connect time is `failed` with `HEADERS_HELPER_AUTH_REJECTED`, which is in the binary's auto-reconnect-eligible set (`rqe`), not `needs-auth`.
- Before **2.1.238**, SDK sessions ran helpers without trust checks. That's irrelevant for dynamic scope.

**T3 uses the user's Claude binary** (`pathToClaudeCodeExecutable`, `ClaudeAdapterV2.ts` ~L670-690), so the behaviour depends on what the user has installed. The pinned SDK corresponds to 2.1.276, which is past every change above.

**Verdict:** it works, but T3 doesn't need it. [#10](https://github.com/TFordyce/t3code/issues/10) already re-injects refreshed headers through `setMcpServers`.

## Pi

- **Syntax:** `"Authorization": "!<command>"`. The command must be the whole value, and stdout (trimmed) becomes the value ([`docs/mcp.md` L81](https://github.com/earendil-works/pi/blob/4ac0bd8c7b96d72cb6a73226edc7c9ecaae1d14e/packages/coding-agent/docs/mcp.md)). Registered servers use the same shape (`pi.registerMcpServer`, L260).
- **Evaluation:** `createDefaultTransport` calls `resolveHeadersOrThrow` → `resolveConfigValueOrThrow` → `resolveConfigValueUncached` (`src/extensions/mcp/runtime.ts` ~L100-108; `src/core/resolve-config-value.ts` L229-282). The same at `v0.99.0`, so MCP headers are **not** cached.
  - Model-provider API keys do use the process-lifetime `commandResultCache`. Don't confuse the two.
  - `execSync`/`spawnSync`, 10 s timeout, inherits `process.env`. T3 already puts `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN` there (`packages/provider-pi/src/server/mcpExtensionSource.ts` L14-16).
  - It's synchronous, so it blocks Pi's event loop while it runs.
- **When:** only when a transport is created, in `connectOnce()`. That happens on first connect, after the transport closes, on a 404 session-expiry retry, on `/mcp` reconnect, or on re-registration with a changed config.
  - A 401 on a server configured with a static `Authorization` is **not** retried. `usesOAuth()` is false, so there's no `authProvider`, and `needsSignIn()` is false, so the error is just thrown.
  - So `!command` does not close the gap.
- **Better lever:** when an extension calls `registerMcpServer` again with a different config, Pi drops that server and reconnects it (`src/extensions/mcp/index.ts` L1219-1236, compared on `registeredConfig`). T3's own Pi extension already holds a session credential for T3. It can fetch a fresh header from T3 and re-register before expiry or after a failure.
- **Version:** built-in MCP, `registerMcpServer` and `!command` headers all arrived in **0.99.0**. T3's `MINIMUM_PI_VERSION` is 0.80.5, and user servers already require 0.99 ([#3](https://github.com/TFordyce/t3code/issues/3)).
- **Rejected alternative:** Pi's `auth: {provider}` reads a Pi model-provider token per request (0.99.2). Wiring T3 OAuth into a fake model provider is more machinery than re-registering.

## Muse

`@muse-code/sdk` 1.4.2 `SessionMcpServerConfig` (`dist/src/msp.d.ts` L1362):

- streamable HTTP is `{headers?, mode?, transport, url}`, with no helper and no mid-session update;
- stdio is `{command, args?, env?, framing?, mode?}`.

The only refresh path is to make T3 the HTTP client through a stdio bridge.

## How a helper would authenticate to T3

**What exists:**

- **`t3-code` MCP credential.**
  - `McpSessionRegistry.issue` mints a random 32-byte bearer per provider session. Only its SHA-256 is stored, in memory.
  - It's scoped to one thread (`threadId`, `providerSessionId`, capabilities), revoked when the session stops, and expires after 24 h of no liveness (`apps/server/src/mcp/McpSessionRegistry.ts` L68-166).
  - `/mcp` is mounted outside the environment auth stack, and this token is its only guard (L78-80; route at `apps/server/src/mcp/McpHttpServer.ts` L864).
  - The endpoint is `http://127.0.0.1:<port>/mcp` for wildcard binds, and the bound address otherwise. Providers always run on the environment host, so it's always reachable.
  - Every adapter already hands this token to the provider:
    - Codex: `http_headers`, through thread config over stdin.
    - Claude: env `T3_CODE_MCP_AUTHORIZATION`.
    - Pi: env `T3_MCP_BEARER_TOKEN`.
    - ACP: env `T3_ACP_MCP_AUTHORIZATION` on the bridge child (`packages/provider-acp/src/server/adapter.ts` L680-715).
- **`t3 pair`** finds the live server from `server-runtime.json` and mints a pairing link by opening `EnvironmentAuth` against the T3 home database directly (`apps/server/src/cli/pair.ts` L428-451). That is filesystem trust producing environment-wide client credentials. It's the wrong model for a per-request helper: too broad, and it writes to the DB.
- **`t3 acp-mcp-bridge`** is the precedent for a hidden child-invoked subcommand.
  - It has a `bin.ts` fast path, so it skips the full CLI graph on first-message latency.
  - It's invoked through `resolveSelfInvocation`, and Electron needs `ELECTRON_RUN_AS_NODE=1` (`packages/shared/src/nodeRuntime.ts` L29-66).
  - Its credential is passed in env, "never the command line".

**What a helper would need.** A loopback route next to `/mcp`, authenticated with the same per-session bearer. It resolves the caller's thread → project → `(scope, name)` exactly as the merge service does. If the entry has a sign-in, it returns the current header, refreshing first if it's near expiry. The header is bound to the granted resource URL ([#12](https://github.com/TFordyce/t3code/issues/12)). The helper only fetches and prints.

How the helper gets the credential, per provider:

- **Claude, Pi:** inherited env already has it. Only the endpoint and name need passing, and argv is fine for those because they're not secrets.
- **Codex:** env is cleared, and argv is world-readable on Linux (`/proc/<pid>/cmdline`). This token also grants the `t3-code` toolkit (orchestration, worktree), so it must not go in the command. The workable option: T3 writes a per-session file with user-only permissions under T3 home, puts its path in the command, and deletes it when the session stops. The command also has to set `ELECTRON_RUN_AS_NODE=1` inline for desktop builds (`VAR=1 exec …` / `set "VAR=1" && …` under `cmd /D /C`), because Codex won't pass it through.

## Recommendation

**Not in v1.** Ship the service method (`current header for (scope, name)`, refresh-if-near-expiry) and a session-token-authenticated loopback route. The bridge needs them anyway, and any later helper would be a thin client on top.

- **Claude:** covered by `setMcpServers` re-injection. Its `headersHelper` would be a nicer per-401 fallback, but it adds a second refresh path for the same result.
- **Pi:** `!command` doesn't refresh on 401. Have T3's Pi extension re-register the server with a fresh header instead. That's the same "T3 re-injects" pattern, and it needs no child process.
- **Codex and Muse:** these are the real gap. The smallest fix that covers both is to send **OAuth-signed-in** entries through the generalised stdio→HTTP bridge, which ACP already needs ([#3](https://github.com/TFordyce/t3code/issues/3)).
  - T3 is then the HTTP client: it gets the header per request and retries once on 401.
  - The cost is one Node child per such server per session, and the provider no longer sees the upstream status directly.
  - Non-OAuth servers stay native HTTP.
- **Fallback if bridging Codex is unwanted:** a Codex-only `t3 mcp-auth-header` helper. Minimal shape:
  - Hidden subcommand on the `bin.ts` fast path.
  - `mcp_servers.<name>.http_headers_helper = '<self> mcp-auth-header --session-file <path> <name>'`, sent in thread config.
  - No `http_headers.Authorization` alongside it.
  - Prints `{"Authorization":"Bearer …"}`.
  - Gated on Codex ≥ 0.152.
  - Per-session 0600 credential file, cleaned up on stop.

## Caveats

- Nothing was run live. Codex `http_headers_helper` through app-server **thread config overrides**, and Claude `headersHelper` through SDK `mcpServers`, are inferred from source, schema and docs.
- Claude evidence comes from minified CLI code in the 2.1.296 binary plus official docs. T3 runs the user's own Claude binary, so behaviour depends on its version.
- Codex: a native keyring OAuth login for the same URL overrides helper headers.
- Pi was read at `main` (1.1.0). Header resolution was spot-checked at `v0.99.0`.
- Token lifetimes vary by authorization server. T3 releases provider sessions after 30 idle minutes (`ProviderSessionManager.ts` L54), so the gap only hits sessions that stay active past one access token's lifetime.
