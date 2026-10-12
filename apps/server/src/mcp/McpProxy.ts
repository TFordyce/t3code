/**
 * Loopback proxy in front of user HTTP MCP servers.
 *
 * A provider is handed `/mcp-proxy/<name>` plus its session's `t3-code`
 * bearer, never the upstream URL or headers. Each request is checked against
 * what the session was given when it started (the name, and the upstream URL
 * it was started with) and then against live settings, so removing an entry or
 * changing its URL cuts a running session off at once. Allowed requests go
 * upstream through {@link McpUpstream}, which adds the current headers.
 * Streamable HTTP and SSE bodies stream through; upstream statuses are not
 * rewritten.
 *
 * @module McpProxy
 */
import { MCP_PROXY_PATH_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpUpstream from "./McpUpstream.ts";

/** Request headers worth forwarding. Everything else, including the T3 bearer, stays here. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

/** Response headers that describe the hop to us rather than the payload. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

const forbidden = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "mcp_proxy_forbidden", message }, { status: 403 });

const handler = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const upstream = yield* McpUpstream.McpUpstream;
  const request = yield* HttpServerRequest.HttpServerRequest;

  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7).trim() : "";
  const scope = yield* registry.resolve(token);
  if (scope === undefined) {
    return HttpServerResponse.jsonUnsafe(
      { error: "invalid_mcp_credential", message: "A valid T3 Code MCP credential is required." },
      { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
    );
  }

  const pathname = new URL(request.url, "http://localhost").pathname;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(MCP_PROXY_PATH_PREFIX.length));
  } catch {
    return forbidden("Unknown MCP server.");
  }
  const slot = yield* sessions.read(scope.thread.threadId);
  const granted = slot?.userMcp?.servers.find(
    (server) => server.name === name && server.transport === "http",
  );
  if (granted?.transport !== "http") return forbidden("This session has no such MCP server.");

  // Live lookup: a removed, disabled or re-pointed entry is refused immediately.
  const entry = yield* upstream.resolve(name, null);
  if (entry === undefined || entry.urlFingerprint !== granted.upstreamUrlFingerprint) {
    return forbidden("This MCP server is no longer available to this session.");
  }

  const headers: Record<string, string> = {};
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[header];
    if (value !== undefined) headers[header] = value;
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? new Uint8Array(yield* request.arrayBuffer) : undefined;

  const response = yield* upstream
    .send(entry, { method: request.method, headers, ...(body === undefined ? {} : { body }) })
    .pipe(Effect.result);
  if (response._tag === "Failure") {
    yield* Effect.logWarning("User MCP server unreachable through the proxy.", { name });
    return HttpServerResponse.jsonUnsafe(
      { error: "mcp_upstream_unreachable", message: "The MCP server could not be reached." },
      { status: 502 },
    );
  }
  const passed: Record<string, string> = {};
  for (const [header, value] of Object.entries(response.success.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(header) && value !== undefined) passed[header] = value;
  }
  return HttpServerResponse.stream(response.success.stream, {
    status: response.success.status,
    headers: passed,
  });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("MCP proxy request failed.", cause).pipe(
      Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
    ),
  ),
);

export const layer = HttpRouter.add("*", `${MCP_PROXY_PATH_PREFIX}*`, handler);
