# User MCP servers

The loopback proxy is the only path for user HTTP servers. Keep it that way.

A provider gets `/mcp-proxy/<name>` on the T3 MCP endpoint, plus the session's own `t3-code`
bearer. It never gets the upstream URL or the entry's headers. The proxy checks each request
against the grant the session started with, then against live settings, so a removed, disabled
or re-pointed server is cut off mid-session. [`McpUpstream`](../../apps/server/src/mcp/McpUpstream.ts)
adds headers and OAuth tokens on the host, and
[`McpProxy`](../../apps/server/src/mcp/McpProxy.ts) forwards the response.
Sign-in tokens live in the environment's secret store, and
[`McpSignIn`](../../apps/server/src/mcp/McpSignIn.ts) reads them on each request.

The proxy keeps two things in one place. Duplicating them per provider would let each copy
drift:

- **Credentials.** A provider never holds a token, so signing out or changing a header takes
  effect at once, including in sessions already running. Injecting headers into a provider's
  config instead would freeze them at session start.
- **Refresh.** Token refresh and the single retry after a 401 happen in `McpUpstream`. A
  provider that refreshes on its own would race T3's refresh and hold a stale token.

When adding a provider or changing an adapter, give it the session's user HTTP servers as
they are (their URL is already the proxy address) and let the provider reach them with the
session bearer. Do not translate an entry's headers into the provider's native config, and do
not have an adapter refresh or sign in on its own. Claude's adapter uses `${VAR}` placeholders
to pass the session bearer and stdio environment values without putting them in argv. Those
are never upstream headers. Cursor reads the session's servers at the start of each turn and
passes them when it creates or resumes its agent. It never sets them on `send()`, because a
send-time override turns off the servers the agent already loaded.

Providers declare what they can carry in `tools.userMcpTransports`
([`userMcpTransports.ts`](../../apps/server/src/provider/userMcpTransports.ts)). Pi's answer
depends on its version, so it is computed when the adapter reads the version.
