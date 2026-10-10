# Where should MCP server secrets live?

Research for [TFordyce/t3code#2](https://github.com/TFordyce/t3code/issues/2) (map: [#1](https://github.com/TFordyce/t3code/issues/1)).
Source of truth is the code at commit `c77a7b7eeb`. All paths are relative to the repo root.

## Answer

Reuse the pattern T3 already uses for sensitive provider environment variables. Each MCP header and
stdio env entry is a `{ name, value, sensitive, valueRedacted }` row (the existing
`ProviderInstanceEnvironmentVariable` shape). Sensitive values are moved into the server secret store on
write. `settings.json` keeps only `value: "", valueRedacted: true`. Clients get the redacted form and
send it back to mean "keep what's stored". The server materializes plaintext only in-process, when it
builds a provider session.

No new mechanism, RPC, or client secret API is needed. The work is to extend three existing functions
in `apps/server/src/serverSettings.ts` (redact, persist, materialize) to cover global
`mcpServers` and `projectSettingsOverrides[*].mcpServers`.

## The existing mechanism

### 1. The secret store (`ServerSecretStore`)

- `apps/server/src/auth/ServerSecretStore.ts:138-152` is a flat key/value service: `get`, `set`,
  `create` (exclusive), `getOrCreateRandom`, `remove`, keyed by name and holding raw bytes.
- It's file-backed. Each secret is `<secretsDir>/<name>.bin`. The directory is chmod `0700` and the
  files `0600`, written with temp-file + rename (`ServerSecretStore.ts:161-172`, `190-225`).
- `secretsDir` is `<stateDir>/secrets` (`apps/server/src/config.ts:167`), so it lives under the
  environment's T3 home. It's per environment and never synced.
- Values are **not encrypted at rest** and there's no OS keychain. The protection is filesystem
  permissions plus "never in settings.json, never over the wire". That's the trust level every
  existing T3 secret already has.

Current users: provider auth blobs (`apps/server/src/provider/ProviderCredentialStore.ts:7-24`, key
`provider-auth-<sha256>`), provider env secrets, the usage-limit hub key, Bitbucket and GitHub tokens
(`serverSettings.ts:142-169`), agent-requested secrets (`apps/server/src/secrets/SecretRequests.ts`),
and auth/OAuth signing material (`apps/server/src/auth/McpOAuth.ts`, which is T3's _own_ MCP endpoint
auth and unrelated to outbound user servers).

### 2. Settings with secret fields: sentinel + secret store

All of this is in `apps/server/src/serverSettings.ts`:

- **Contract.** `ProviderInstanceEnvironmentVariable = { name, value, sensitive, valueRedacted? }`
  (`packages/contracts/src/providerInstance.ts:104-109`). Scalar secret fields (hub key, Bitbucket,
  GitHub tokens) use a sentinel string, `SECRET_REDACTED = "••••••"` (`serverSettings.ts:150-154`).
- **Key naming.** Store names are derived deterministically from the owning path, base64url-encoded so
  any id is filename-safe. For example, `provider-env-<b64(instanceId)>-<b64(varName)>`
  (`serverSettings.ts:142-147`) and `github-token-<b64(host)>` (`:167-169`).
- **Write path.** `updateAndPersistSettings` (`:1250-1283`) runs
  `persistProviderEnvironmentSecrets(current, next)` (`:998-1172`):
  - A new sensitive value becomes a `write` change, and the row becomes `value:"", valueRedacted:true`.
  - A row flipped to non-sensitive or cleared becomes a `remove` change.
  - A row that disappears becomes a `remove-stale-secret` change (`:1066-1080`).
  - Secret changes are applied _before_ `settings.json` is written, with rollback on any failure
    (`applyProviderEnvironmentSecretChanges` `:1200-1248`, rollback `:1174-1198`).
  - All of this runs under the settings write semaphore.
- **Hand-edited plaintext.** Tokens a user types straight into `settings.json` are moved into the store
  on load (`moveInlineBitbucketTokens` `:726-770`).
- **Read path (server-internal).** `getSettings` and `withSettingsSnapshot`
  (`:1403-1406`, `:1285-1292`) call `materializeProviderEnvironmentSecrets` (`:879-970`), which swaps
  each redacted marker for the stored plaintext. Server code, including adapters, sees real values.
- **Wire path.** Every client-facing exit calls `redactServerSettingsForClient` (`:187-220`):
  - `server.getSettings` (`apps/server/src/ws.ts:2389-2390`)
  - the `server.updateSettings` response (`ws.ts:2391-2403`)
  - the server-config snapshot (`ws.ts:1685`)
  - the `settingsUpdated` stream (`ws.ts:3027-3028`)

  Sensitive values leave as `value:"", valueRedacted:true`, and scalar tokens as the sentinel.

### 3. How clients write and read secrets

- There's no separate secret RPC for settings. Clients write through the normal `server.updateSettings`
  patch (`packages/contracts/src/rpc.ts:479-480`, `754-760`) and never read plaintext back.
- In the web UI (`apps/web/src/components/settings/ProviderInstanceCard.tsx`):
  - Sensitive rows render as password inputs.
  - A redacted row shows an empty input with the placeholder "Stored secret, enter a new value to
    replace" (`:415-420`).
  - Typing sets `value` and clears `valueRedacted` (`:358`).
  - New rows default to `sensitive: true` (`:239`, `:248`, `:379`).
  - Leaving the row alone sends the redacted marker back, which means "keep".
- Agent-requested secrets (`SecretRequests.ts:1-10`) use a separate one-use `SecretRef` flow (24h TTL,
  consumed on read). That's built for agent tool calls and doesn't fit long-lived MCP config.

### 4. Gotcha: getting the secret to the provider without leaking it locally

The built-in `t3-code` server already deals with this:

- **Claude.** The SDK passes `mcpServers` as an inline `--mcp-config` **argv**, which any local user
  can read. So the adapter writes `Authorization: "${T3_CODE_MCP_AUTHORIZATION}"` and puts the real
  value in the child's environment, which the CLI expands
  (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:998-1033`).
- **Codex.** It sends `mcp_servers.*.http_headers` inside thread config over the app-server JSON-RPC
  channel, not argv (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1300-1329`).

User MCP servers need the same per-adapter care. For Claude, _every_ sensitive header and every stdio
env value has to go through a generated env var plus a `${VAR}` reference, never inline in
`--mcp-config`. ACP-style adapters (Cursor, Grok, OpenCode, Antigravity) and Codex send config over
their stdio protocol, so inline values are fine there. That's a per-adapter decision to record in the
adapter ticket.

## Options

### A. Inline sensitive rows, store-backed (recommended)

Model headers and env as arrays of `ProviderInstanceEnvironmentVariable`-shaped rows. Extend
persist, materialize, and redact to walk `settings.mcpServers[name].{headers,env}` and
`projectSettingsOverrides[projectId].mcpServers[name].{headers,env}`. Key names would look like
`mcp-<scope>-<b64(scopeId)>-<b64(server)>-<header|env>-<b64(name)>`.

- **Pros**
  - Zero new concepts, RPCs, or client APIs.
  - Identical UX to provider env vars, and `ProviderInstanceCard`'s row editor can likely be reused.
  - Plaintext never sits in `settings.json` and never crosses the websocket, including to mobile and
    remote/tunnel clients and to the `t3_environment_read` MCP tool, which only exposes preferences.
  - Atomic with the settings write, with rollback.
- **Cons**
  - `serverSettings.ts`'s secret code is already long, with four bespoke secret kinds. A fifth (and a
    nested project scope) should drive a small refactor into one generic "secret field walker" rather
    than a fifth copy-paste.
  - Renaming a server, deleting a project, or removing a project override has to sweep stale keys. The
    existing `remove-stale-secret` diff already handles this if the walker covers both scopes.
  - Secrets are per (server, header). The same token used by two servers is entered twice.

### B. Named secret references (`${secret:NAME}` or `{ secretRef: "NAME" }`)

Add a user-managed named-secrets list with a "Secrets" settings section and set/delete RPCs. MCP
config only references names.

- **Pros:** one token can be shared across servers and scopes. Configs could later be shared through
  `t3.json` without secrets, since references are safe to check in. That matches the open "Sharing via
  `t3.json`" item on the map.
- **Cons:** it's a new surface: contracts, a guarded RPC added to `CLIENT_GUARDED_RPC_SCOPES`, a web
  UI, mobile read-only views, docs. You also get dangling-reference states (a reference to a missing
  secret) that need UI and status. That's more machinery than the panel needs now, and the existing
  code has no precedent for it. YAGNI until `t3.json` sharing is actually picked up.

### C. OS keychain (Keychain, Credential Manager, libsecret)

- **Pros:** encrypted at rest.
- **Cons:** it doesn't exist anywhere in T3 today. It breaks headless `npx t3`, SSH, and Linux servers
  without a keyring, and it would split the trust model from every other secret. Out of scope. If
  at-rest encryption is ever wanted, it belongs in `ServerSecretStore` for all secrets at once.

### D. Plaintext in `settings.json`, redacted only on the wire

- **Pros:** trivial.
- **Cons:** the token sits on disk in a file users copy, back up, and paste into bug reports. That
  contradicts the precedent set for Bitbucket and GitHub, where hand-edited tokens are actively moved
  out (`serverSettings.ts:726-770`). Rejected.

## Recommendation and follow-ups

1. **Choose A.** Put headers and env in the `{name, value, sensitive, valueRedacted}` row shape in
   `packages/contracts/src/settings.ts`, for both the global `mcpServers` and the new
   `ProjectSettingsOverrides.mcpServers` key. Default `sensitive: true` for headers and env in the UI.
   URL, command, and args stay non-secret. Warn in the UI that args are visible in the process list.
2. Fold the per-kind secret handling in `serverSettings.ts` into one generic walker as part of the
   change, so MCP isn't a fifth bespoke copy.
3. Stale-secret cleanup has to cover server rename/delete, project override removal, and project
   deletion.
4. Adapter ticket: Claude must pass every user-server secret through env-var indirection
   (`ClaudeAdapterV2.ts:998-1033` pattern). Record the decision for each other adapter.
5. Option B stays available later as an additive layer (a row whose value is a reference) if
   `t3.json` sharing lands.
6. OAuth tokens for HTTP MCP servers, if they're adopted, should go into the same `ServerSecretStore`,
   keyed by server, the way `ProviderCredentialStore` does for provider auth. That's a separate ticket.
