import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/** A user MCP server a provider launches itself, with secrets already read from the store. */
export interface UserMcpStdioServer {
  readonly name: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Real values, held in server memory only; never logged or sent to a client. */
  readonly env: Readonly<Record<string, string>>;
}

/** The resolved user servers a session carries; the union grows with each transport. */
export type UserMcpServer = UserMcpStdioServer;

export interface SkippedUserMcpServer {
  readonly name: string;
  readonly reason: "secret-unavailable";
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
