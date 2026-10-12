import type { McpServerConfig, ProjectId, ServerSettings } from "@t3tools/contracts";

/** Where a resolved server is configured. */
export type McpServerSource = "global";

export interface ResolvedMcpServer {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: McpServerSource;
}

/**
 * The user MCP servers a project's sessions get, in name order. The panel and
 * the session manager both read this, so what the panel shows is what sessions
 * receive. Only environment-wide entries exist so far, and disabled ones drop
 * out; `projectId` is where project overrides will merge in.
 */
export function resolveMcpServers(
  settings: Pick<ServerSettings, "mcpServers">,
  _projectId: ProjectId | null,
): ReadonlyArray<ResolvedMcpServer> {
  return Object.entries(settings.mcpServers)
    .filter(([, config]) => config.enabled !== false)
    .map(([name, config]): ResolvedMcpServer => ({ name, config, source: "global" }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
