// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto is async; the fingerprint is needed synchronously.
import { createHash } from "node:crypto";

import type {
  EnvironmentId,
  McpSessionServerStatus,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

/** A user MCP server a provider launches itself, with secrets already read from the store. */
export interface UserMcpStdioServer {
  readonly name: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Real values, held in server memory only; never logged or sent to a client. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A user HTTP server as a provider sees it: only the T3 loopback proxy address.
 * The provider authenticates to the proxy with the session's `t3-code` bearer
 * (`authorizationHeader`); the upstream URL and its headers never reach it.
 */
export interface UserMcpHttpServer {
  readonly name: string;
  readonly transport: "http";
  /** `<MCP endpoint origin>/mcp-proxy/<name>`. */
  readonly url: string;
  /**
   * Fingerprint of the upstream URL the session started with. The proxy answers
   * 403 once the entry's URL no longer matches, so a running session cannot
   * keep reaching a server it was never configured with. Server-side only.
   */
  readonly upstreamUrlFingerprint: string;
  /**
   * The thread's project, so the proxy resolves this server the way the
   * session did, including later project overrides and markers.
   */
  readonly projectId?: ProjectId;
}

/** The resolved user servers a session carries; the union grows with each transport. */
export type UserMcpServer = UserMcpStdioServer | UserMcpHttpServer;

/** Stable stand-in for an upstream URL, which may carry a token in its query. */
export function upstreamUrlFingerprint(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** The path the loopback proxy serves a user HTTP server at, under the MCP HTTP server. */
export const MCP_PROXY_PATH_PREFIX = "/mcp-proxy/";

/** Proxy address for `name`, given the session's `t3-code` MCP endpoint (`…/mcp`). */
export function mcpProxyUrl(mcpEndpoint: string, name: string): string {
  const url = new URL(mcpEndpoint);
  return `${url.origin}${MCP_PROXY_PATH_PREFIX}${encodeURIComponent(name)}`;
}

export interface SkippedUserMcpServer {
  readonly name: string;
  /** `unsupported` is a server the resolver already knows no adapter can carry. */
  readonly reason: "secret-unavailable" | "unsupported";
}

export interface UserMcpSessionServers {
  readonly servers: ReadonlyArray<UserMcpServer>;
  readonly skipped: ReadonlyArray<SkippedUserMcpServer>;
}

/**
 * The servers an adapter should pass on, given the transports it declares in
 * `userMcpTransports`. An adapter skips any transport it does not list.
 */
export function userMcpServersFor(
  config: Pick<McpProviderSessionConfig, "userMcp"> | undefined,
  transports: ReadonlyArray<UserMcpServer["transport"]>,
): ReadonlyArray<UserMcpServer> {
  return (config?.userMcp?.servers ?? []).filter((server) => transports.includes(server.transport));
}

/**
 * The session MCP status list an adapter publishes: every user server the
 * session was handed, with the provider's own report where it has one. Servers
 * the adapter cannot carry are `unsupported`, an unreadable secret is `failed`,
 * and anything the provider has not reported is `unknown`. Providers' own
 * servers, including `t3-code`, are never listed. `undefined` means the session
 * has no user servers, so the adapter should not set the field at all.
 */
export function sessionMcpStatuses(input: {
  readonly config: Pick<McpProviderSessionConfig, "userMcp"> | undefined;
  readonly transports: ReadonlyArray<UserMcpServer["transport"]>;
  readonly reported?: ReadonlyArray<McpSessionServerStatus>;
}): ReadonlyArray<McpSessionServerStatus> | undefined {
  const userMcp = input.config?.userMcp;
  if (userMcp === undefined || (userMcp.servers.length === 0 && userMcp.skipped.length === 0)) {
    return undefined;
  }
  const reported = new Map((input.reported ?? []).map((entry) => [entry.name, entry]));
  return [
    ...userMcp.servers.map((server): McpSessionServerStatus =>
      !input.transports.includes(server.transport)
        ? { name: server.name, status: "unsupported" }
        : (reported.get(server.name) ?? { name: server.name, status: "unknown" }),
    ),
    ...userMcp.skipped.map((skipped): McpSessionServerStatus =>
      skipped.reason === "unsupported"
        ? { name: skipped.name, status: "unsupported" }
        : { name: skipped.name, status: "failed", error: "secret unavailable" },
    ),
  ];
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * User MCP servers (`settings.mcpServers`) resolved for the thread's project
   * on every prepare, even when the `t3-code` credential is reused. Absent when
   * the session is not configured for MCP.
   */
  readonly userMcp?: UserMcpSessionServers;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
