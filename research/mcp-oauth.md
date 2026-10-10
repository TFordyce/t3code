# How should OAuth-protected HTTP MCP servers be authorized?

Research for [TFordyce/t3code#10](https://github.com/TFordyce/t3code/issues/10) (map: [#1](https://github.com/TFordyce/t3code/issues/1)).
This builds on `research/mcp-provider-status.md` (status vocabularies), `research/mcp-adapter-transports.md` (injection paths) and `research/mcp-secrets.md` (secret storage). It does not repeat them.

Checked on 2026-10-10 against:

- the code at `origin/main` `375405e10e`;
- the installed `@anthropic-ai/claude-agent-sdk` 0.3.276 and the Claude Code 2.1.296 binary;
- the Codex app-server schema in `packages/effect-codex-app-server/src/_generated`, plus `openai/codex` `main` at `806d9732c9`;
- `@opencode/*` 2.0.23 and `@opencode-ai/sdk` 1.15.13;
- `@cursor/sdk` 1.0.35 and `@muse-code/sdk` 1.4.2;
- the ACP schema in `packages/effect-acp`;
- `@modelcontextprotocol/sdk` 1.29.0, which `apps/server/package.json` already depends on;
- the MCP authorization spec, versions [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Answer

**Run the OAuth flow once, in the T3 server on the environment host, using the MCP TS SDK's `auth()` behind an `OAuthClientProvider` backed by `ServerSecretStore`.** Hand the resulting access token to every provider as a plain `Authorization: Bearer` header through the injection paths that already exist. T3 owns refresh.

The redirect URI is a loopback URI on the host. When the user's browser is on another device, the redirect cannot load there. T3 then takes the pasted redirect URL over the WebSocket instead. This is the same fallback Claude Code, Codex CLI and Pi already use over SSH.

Provider-run flows are not a usable base. Only four providers (Codex, Claude, OpenCode, Pi) can run one. Each stores tokens in the user's personal provider store, each needs its own consent, and Cursor, Muse and every ACP agent cannot do it at all. All six providers in scope can accept a bearer header.

## (a) Per-provider: does the provider run MCP OAuth itself?

| Provider                              | Runs OAuth itself?                                                                                                                                                                              | How T3 would trigger it                                                                                                                                                                                                         | Where tokens live                                                                                                                     | Remote client: redirect/callback story                                                                                                                                                                                                                                                                                                                | Accepts a T3-held bearer header?                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex** (app-server)                | Yes. CIMD, DCR or a pre-registered `oauth.client_id`, picked by `clientRegistration: auto\|cimd\|dcr`                                                                                           | `mcpServer/oauth/login {name, threadId?, scopes?, clientRegistration?, timeoutSecs?}` → `{authorizationUrl}`, then `mcpServer/oauthLogin/completed`                                                                             | OS keyring (service `Codex MCP Credentials`), falling back to `CODEX_HOME/.credentials.json`. Keyed by server name + URL              | Codex binds its own listener at `http://127.0.0.1:<port>/callback` on the host. The app-server has **no method to submit a pasted redirect** (the CLI does). `mcp_oauth_callback_url` can point at an ingress URL, but a non-loopback callback URL makes Codex bind `0.0.0.0`. Remote only works if T3 relays the pasted URL to the loopback listener | Yes: `http_headers.Authorization` (current T3 path), `bearer_token_env_var`, or `http_headers_helper` (a command, re-run once after a 401/403). Explicit bearer tokens take precedence over stored OAuth                                                                               |
| **Claude** (Agent SDK)                | Yes. DCR, CIMD and pre-registered `oauth.clientId` are all supported                                                                                                                            | Undocumented control requests: `mcp_authenticate {serverName, redirectUri?}` → `{authUrl, requiresUserAction, callbackExpected, redirectScheme, state, callbackPort?}`, then `mcp_oauth_callback_url {serverName, callbackUrl}` | `mcpOAuth` in Claude's secure storage: macOS keychain, otherwise `~/.claude/.credentials.json` (plaintext). Keyed per endpoint/config | **Remotely drivable**: T3 can pass `callbackUrl` (the pasted redirect) back through the control channel, and Claude checks `state`. `redirectUri` lets the host choose a custom redirect, used only with DCR. Claude falls back to localhost if the AS rejects it. Note that a `-p`/SDK run alone never starts the flow: it only reports `needs-auth` | Yes: `headers.Authorization` through `${VAR}` env indirection (current T3 path). With a configured `Authorization`, a 401 is reported as `failed`, not `needs-auth`, and Claude does not fall back to OAuth. `headersHelper` is documented for config files, but the SDK type lacks it |
| **OpenCode 1.x** (`@opencode-ai/sdk`) | Yes. DCR or pre-registered `oauth.clientId/clientSecret`                                                                                                                                        | `POST /mcp/{name}/auth` → `{authorizationUrl}`; `POST /mcp/{name}/auth/callback {code}`; `POST /mcp/{name}/auth/authenticate` (opens a browser)                                                                                 | `~/.local/share/opencode/mcp-auth.json`                                                                                               | Default redirect is `http://127.0.0.1:19876/mcp/oauth/callback` on the host, configurable via `oauth.redirectUri` / `callbackPort`. **Remotely drivable**: the `/auth/callback` endpoint takes the code directly                                                                                                                                      | Yes: `RemoteConfig.headers` with `oauth: false` (T3 already does this for `t3-code`). Re-running `mcp.add` replaces the server with fresh headers                                                                                                                                      |
| **OpenCode 2.x** (`@opencode/*`)      | Yes, through "integrations". `mcp.list` entries carry `integrationID`. `Mcp.OAuthConfig` has `client_id`, `client_secret`, `scope`, `callback_port`, `redirect_uri`, `auth_server_metadata_url` | `integration.oauth.connect` → `Attempt {attemptID, url, instructions, mode: "auto" \| "code"}`; poll `integration.oauth.status`; `integration.oauth.complete {code}`                                                            | OpenCode credential store (`credential.list` returns stored secrets in plaintext)                                                     | **Remotely drivable in `code` mode** through `complete {code}`. `auto` mode relies on a local callback. Not exercised live                                                                                                                                                                                                                            | Yes: `RemoteConfig {headers, oauth: false}`, re-added through `mcp.add`                                                                                                                                                                                                                |
| **Cursor** (`@cursor/sdk`)            | Internally yes. The bundle has an MCP OAuth state machine (`requires_authentication` → `needsAuth`), `mcp-auth.json` token files and `auth: {CLIENT_ID, CLIENT_SECRET?, scopes?}` config        | **No public API.** Nothing in the SDK typings starts, completes or reports an MCP login                                                                                                                                         | `mcp-auth.json` under the Cursor project/user dir (from the bundle)                                                                   | Not drivable. The redirect URIs in the bundle are `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`                                                                                                                                                                                                             | Yes: `{type:"http", url, headers}`. T3 passes `mcpServers` on every `send()`, so a fresh token per turn costs nothing                                                                                                                                                                  |
| **Muse** (MSP)                        | No. `SessionMcpServerConfig` streamable-HTTP is `{url, headers, mode}` only                                                                                                                     | n/a                                                                                                                                                                                                                             | n/a                                                                                                                                   | n/a                                                                                                                                                                                                                                                                                                                                                   | Yes: `headers`, at `session/start` and `session/resume` only                                                                                                                                                                                                                           |
| **Generic ACP / Grok / Antigravity**  | No. ACP `McpServerHttp` is `{name, url, headers}`. No auth method or status exists in ACP                                                                                                       | n/a                                                                                                                                                                                                                             | n/a (whatever the agent does internally is invisible)                                                                                 | n/a                                                                                                                                                                                                                                                                                                                                                   | Yes, and best case: the transports research recommends HTTP over T3's own `t3 acp-mcp-bridge` (stdio→HTTP). **T3 is the HTTP client**, so it can attach and refresh the token per request                                                                                              |
| **Pi**                                | Yes, natively (Pi ≥ 0.99 `mcp.json`/`registerMcpServer`): DCR (client name `pi`), CIMD (`https://pi.dev/oauth/client.json`) or pre-registered `clientId`                                        | `/mcp login <server>` or `pi mcp login <server>`. No RPC-mode login documented                                                                                                                                                  | `~/.pi/agent/mcp-auth.json`, keyed by server name + URL                                                                               | Loopback `http://127.0.0.1:<port>/callback`. Over SSH the user pastes the redirected URL. Not drivable from T3's RPC session                                                                                                                                                                                                                          | Yes. An `Authorization` header turns Pi's OAuth off. Header values may be `${VAR}` or `!command`. With T3's bridge extension, T3 is the HTTP client                                                                                                                                    |

Sources:

- **Codex**
  - Params and response: `packages/effect-codex-app-server/src/_generated/schema.gen.ts` (`ClientRequest__McpServerOauthLoginParams` ~L17029, `V2McpServerOauthLoginResponse` L53607, `…OauthLoginCompletedNotification` L3141).
  - `threadId` resolves the thread's own MCP config, so T3-injected servers are found: [`codex-rs/app-server/src/request_processors/mcp_processor.rs`](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/app-server/src/request_processors/mcp_processor.rs) `mcp_server_oauth_login_response`.
  - Storage: [`codex-rs/rmcp-client/src/oauth.rs`](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/rmcp-client/src/oauth.rs) L1-17, L100.
  - Bind host: [`perform_oauth_login.rs`](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/rmcp-client/src/perform_oauth_login.rs) `callback_bind_host` (~L526-537).
  - CLI paste path: [`oauth_callback_input.rs`](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/rmcp-client/src/oauth_callback_input.rs).
  - `http_headers_helper` is limited to local servers: [`codex-rs/config/src/mcp_types.rs`](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/config/src/mcp_types.rs) ~L520-533.
  - Config keys and precedence: [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
- **Claude**
  - `Query.mcpAuthenticate(serverName, redirectUri)`, `mcpClearAuth`, `mcpSubmitOAuthCallbackUrl(serverName, callbackUrl)` exist in `@anthropic-ai/claude-agent-sdk/sdk.mjs` but not in `sdk.d.ts`.
  - The response shape and the `state`/redirect fallback come from the `mcp_authenticate` / `mcp_oauth_callback_url` handlers in the Claude Code 2.1.296 binary (`~/.local/bin/claude.exe`). The binary also holds the `mcpOAuth` storage and the `.credentials.json` plaintext warning.
  - `McpHttpServerConfig` has no `oauth`/`headersHelper` field: `sdk.d.ts` L1110-1127.
  - Behaviour: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp). Sections used: "Authenticate with remote MCP servers", "Headless, remote, and SSH environments", "Use pre-configured OAuth credentials", "Use dynamic headers".
- **OpenCode 1.x:** `@opencode-ai/sdk/dist/gen/types.gen.d.ts` L2950-3042. Redirect default: [`packages/core/src/v1/config/mcp.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/mcp.ts). Storage path: [OpenCode MCP docs](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx#oauth).
- **OpenCode 2.x:** `@opencode/protocol/dist/groups/integration.js` L60-111, `credential.js` L11; `@opencode/schema/dist/integration.js` L58-73, `mcp.d.ts` L24-38 and L79.
- **Cursor:** `@cursor/sdk/dist/cjs/options.d.ts` L28-36. Bundle `dist/cjs/689.js` holds the state machine, `mcp-auth.json` and the redirect constants.
- **Muse:** `@muse-code/sdk/dist/src/msp.d.ts` ~L1361.
- **ACP:** `packages/effect-acp/src/_generated/schema-v1.gen.ts` L8512.
- **Pi:** [`earendil-works/pi` `packages/coding-agent/docs/mcp.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).

**T3 today:** nothing calls any of these login APIs. `mcp.oauth.completed` exists in `packages/contracts/src/providerRuntime.ts` (L193) but nothing emits it.

### Remote-client verdict on provider-run flows

Every provider-run flow uses a **loopback redirect on the environment host**. A remote browser can't reach it. The universal fallback is **paste the final redirect URL**.

That paste can reach the provider in two ways:

- **Native submit:** Claude (`mcp_oauth_callback_url`), OpenCode 1.x (`/auth/callback {code}`) and OpenCode 2.x (`complete {code}`).
- **Replay by T3:** T3 requests the pasted `http://127.0.0.1:<port>/callback?code&state` itself from the host, where the provider's listener is. This works for Codex, which has no submit method. It is an unofficial trick that relies on the listener still being up within `timeoutSecs`.

Cursor, Muse and ACP agents cannot be driven at all.

## (b) What a T3-run flow needs on a headless or tunnelled host

**Spec requirements on the client.** All are from the 2025-11-25 spec unless marked 2026-07-28.

- **Discovery.**
  - On a 401, use `WWW-Authenticate: resource_metadata` and fall back to the RFC 9728 well-known URIs (path, then root).
  - Then try the RFC 8414 and OIDC discovery endpoints in the specified order.
  - Clients **MUST** use protected resource metadata for discovery.
- **Client registration**, in **SHOULD** priority order:
  1. Pre-registered client.
  2. CIMD, if the AS advertises `client_id_metadata_document_supported`.
  3. DCR, if there is a `registration_endpoint`.
  4. Prompt the user for client details.

  2026-07-28 **deprecates DCR** ("retained for backwards compatibility"). It requires DCR clients to send `application_type` (`native` for desktop/CLI/localhost apps). It also requires stored client credentials to be keyed by the AS `issuer`, with re-registration when the AS changes.

- **CIMD.** `client_id` is an HTTPS URL with a path. The document lists `redirect_uris`, and the AS fetches it and **MUST** validate redirect URIs against it. The AS must be able to reach that URL, so a tailnet-only host can't self-host a CIMD.
- **Redirect URIs.**
  - "All redirect URIs **MUST** be either `localhost` or use HTTPS."
  - The AS **MUST** exact-match registered URIs.
  - The client **SHOULD** use and verify `state`.

  A LAN `http://192.168.x.x` origin is not allowed. Tailscale Serve and T3 Connect origins are HTTPS, but per-user.

- **PKCE.** S256 is **MUST**. The client **MUST** refuse to proceed if `code_challenge_methods_supported` is absent.
- **`resource` (RFC 8707).** **MUST** be sent on authorization and token requests, using the canonical server URI.
- **Issuer check (2026-07-28 only).** The client **MUST** record the AS `issuer` before redirecting. It **MUST** validate `iss` (RFC 9207) before sending the code to the token endpoint, and reject a missing `iss` when `authorization_response_iss_parameter_supported` is true.
- **Token use.** Send `Authorization: Bearer` on **every** request, never in the query string. Only send tokens issued by that server's AS.
- **Refresh (2026-07-28).** Keep refresh tokens confidential. Request `offline_access` only if the AS lists it. **MUST NOT** assume a refresh token will be issued. The AS **MUST** rotate refresh tokens for public clients.
- **Step-up.** On `403 insufficient_scope`, re-authorize with the union of the previous scopes and the challenged scopes, with retry limits.
- **Device flow is not part of the MCP spec.** T3's own cloud CLI login uses a device-code fallback (`apps/server/src/cloud/CliTokenManager.ts`), but MCP authorization servers can't be assumed to support one.

**What `@modelcontextprotocol/sdk` 1.29.0 gives T3** (`dist/esm/client/auth.{d.ts,js}`, `streamableHttp.{d.ts,js}`):

- `auth(provider, {serverUrl, authorizationCode?, scope?, resourceMetadataUrl?})` runs discovery, registration, PKCE, `resource`, code exchange and refresh.
  - It returns `'AUTHORIZED'` or `'REDIRECT'`.
  - If stored tokens have a `refresh_token`, it refreshes first and only starts a new authorization if that fails (`auth.js` L273-311).
- `OAuthClientProvider` is the storage and UX seam:
  - `redirectUrl`, `clientMetadata`, `clientMetadataUrl?` (CIMD; used only when the AS advertises support, `auth.js` L231-240), `state?()`.
  - `clientInformation`/`saveClientInformation`, `tokens`/`saveTokens`, `codeVerifier`/`saveCodeVerifier`, `discoveryState`/`saveDiscoveryState`, `invalidateCredentials(scope)`.
  - `redirectToAuthorization(url)`: T3 implements this to push the URL to the client instead of opening a browser.

  Back it with `ServerSecretStore` and T3 owns all token state.

- `StreamableHTTPClientTransport({authProvider})` attaches the token, calls `auth()` again on a 401, and has a circuit breaker for "401 after successful auth". `finishAuth(code)` completes a redirect. T3's own `initialize` + `tools/list` check can use this directly.
- **Gaps T3 must fill:**
  - The SDK generates `state` but doesn't validate it on callback. The callback handler must compare it.
  - 1.29.0 has no RFC 9207 `iss` handling: grep finds no `iss`/`authorization_response_iss_parameter_supported` in `auth.js`. For 2026-07-28 conformance, T3 must check `iss` itself or upgrade the SDK.
  - Refresh is reactive: on a 401 or when `auth()` is called. T3 must schedule proactive refresh from `expires_in` before handing a token to a provider.

**Redirect URI on a headless or tunnelled host.** There are three options:

1. **Loopback on the host plus paste.** Register `http://127.0.0.1:<port>/callback` and listen there.
   - Local desktop and browser sessions complete automatically.
   - A remote browser shows "can't connect". The user copies the address-bar URL into T3, which sends it over the WebSocket to the host. The host checks `state` and exchanges the code with the PKCE verifier, which never left the host.
   - The code is useless without the verifier, so its trip over the WebSocket isn't sensitive.
   - Works with DCR, pre-registration, and a static CIMD that lists loopback URIs (the spec's own CIMD example does).
   - This is what Claude, Codex CLI and Pi already ship for SSH.
2. **T3's own HTTPS origin as the redirect**, for example `https://<tunnel-or-tailnet-host>/oauth/mcp-client/callback`. This is precedented: T3's own MCP authorization server already derives every URL from the request origin, so it "answers correctly over loopback, Tailscale Serve and a T3 Connect tunnel" (`apps/server/src/auth/McpOAuth.ts` ~L40-51).
   - It works only for HTTPS origins, so not LAN HTTP.
   - Each origin is a separate redirect URI, so DCR must register per origin.
   - A static CIMD can't list per-user hostnames.
3. **A fixed hosted relay page** (`https://app.t3.codes/...`) that hands the code back to the client that started the flow. This needs a public T3-owned page and CIMD document, so forks and self-hosters inherit a dependency.

## (c) Recommendation for v1

1. **T3 runs the flow; tokens live in `ServerSecretStore`.**
   - Use one `OAuthClientProvider` implementation over the secret store, with keys alongside the `mcp-…` keys proposed in `research/mcp-secrets.md`: client information, tokens, code verifier and discovery state per server.
   - Key client credentials by AS `issuer`, as the 2026-07-28 binding rule requires.
   - Drive it from a service method (for example `McpAuth.startLogin(serverRef)` → `{authorizationUrl, attemptId}` and `McpAuth.completeLogin(attemptId, redirectUrl)`), exposed as guarded RPCs, so the web, desktop and mobile clients, the MCP tools and scheduled tasks all reach the same path. Add both to `CLIENT_GUARDED_RPC_SCOPES`.
   - Add the reverse door: `McpAuth.logout(serverRef)` clears the stored secrets.
2. **Redirect: loopback on the host plus a paste fallback** (option 1).
   - Bind `127.0.0.1` only, never `0.0.0.0`.
   - Show the URL with an "Open" button and a "Paste the address you landed on" field. The field is always visible, because the client can't know whether its browser is on the host.
   - Registration order: user-entered pre-registered client ID/secret (stored as secrets), then DCR with `application_type: "native"`.
   - CIMD can wait until there's a stable public HTTPS URL for a T3 client metadata document (see question 3).
3. **Hand tokens to providers as a bearer header.** Each adapter asks the token service for a token valid for at least a few minutes, refreshing if needed. It then emits `Authorization: Bearer <token>` through the path it already uses:
   - **Claude:** `${T3_MCP_…}` env.
   - **Codex:** `http_headers`.
   - **OpenCode:** `headers` with `oauth: false`, so it never starts its own flow.
   - **Cursor:** `headers` on each `send()`.
   - **Muse:** `headers` at start/resume.
   - **ACP and Pi bridges:** T3's bridge attaches the token per request and refreshes on 401. T3 is the client there.

   Setting the header also stops Claude, Codex and Pi from falling back to their own OAuth, so a provider never writes T3 server tokens into the user's personal keychain or credential file.

4. **Refresh is T3's job.**
   - Refresh proactively before expiry, and on any 401 that T3's own check sees.
   - Re-inject wherever the adapter already rebuilds MCP config: session start and resume on every adapter, every turn on Cursor (`send()`), re-`mcp.add` on OpenCode, and `setMcpServers` on Claude for long sessions.
   - Accepted v1 gap: a Codex or Muse thread that outlives one access token sees its server go `failed` until the next resume. The follow-up fix is a helper command (`t3 mcp-auth-header <server>`, in the style of `t3 acp-mcp-bridge`). Codex runs it via `http_headers_helper` and again after a 401/403, Pi via a `!command` header value, and Claude via `headersHelper`, though that last is unverified through `--mcp-config`.
5. **Status.** T3's host-side check uses the same provider and token, so it moves to `connected` right after login on every provider. The check shows `needs-auth` when there is no token or refresh fails. A provider seeing a 401 on a T3-supplied header reports `failed` (Claude does this explicitly), and the T3 check then shows it as `needs-auth`.

**Why not provider-run:**

- It covers 4 of 6 provider families.
- It needs N consents for N providers.
- It writes into stores T3 doesn't own (keychain, `CODEX_HOME`, `~/.claude`, `~/.local/share/opencode`, `~/.pi`). That is the shared-state version of "never edit provider native config".
- Codex needs the loopback-replay trick to work remotely.
- Status would split by provider.

**Is handing T3-obtained tokens to the provider "token passthrough"?** No. The spec's passthrough ban is about a _server_ forwarding a token it received to an upstream API. Here the token is requested by the environment for that exact `resource` and sent only to that server, which the spec requires.

## (d) New questions that need their own decision

1. **What does a login cover?** Is it keyed by canonical server URL, so global and project entries for the same URL share one login, or by T3 server entry? Codex and Pi key by name + URL; Claude keys per endpoint/config.
2. **Mobile paste UX.** Copying a failed `127.0.0.1` URL out of a mobile browser is awkward. Options: an in-app auth session that intercepts the redirect, or option 2 (HTTPS T3 origin) when connected over a tunnel or Tailscale.
3. **CIMD hosting.** Should T3 publish a client metadata document at a stable public URL (for example on `t3.codes`) with loopback redirect URIs? DCR is deprecated in 2026-07-28, but forks would point at T3's URL unless it's configurable.
4. **Helper command for long sessions.** Is `t3 mcp-auth-header` worth it in v1? Also confirm Claude's `--mcp-config` accepts `headersHelper`, and that T3's pinned Codex version has `http_headers_helper`.
5. **SDK upgrade vs. own `iss` check** for 2026-07-28 RFC 9207 conformance.
6. **Existing provider logins.** If a user already logged into the same server in Codex or Claude natively, T3's header overrides it. Should T3 offer to import those tokens? Probably not: they belong to another client registration.
7. **Step-up scopes at runtime.** A provider that hits `403 insufficient_scope` only reports `failed`. Should T3 surface "needs more access" and re-run login with the union of scopes?
8. **OpenCode external `serverUrl`.** The token would be sent to a server on another host. Allow it, or treat it like stdio and decline?
9. **Clearing on delete.** Removing a server or project, or changing a server's URL, must clear its OAuth secrets. Fold this into the generic secret walker proposed in `research/mcp-secrets.md`.
