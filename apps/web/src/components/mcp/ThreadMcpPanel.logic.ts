import type { McpSessionServerStatus, McpSessionServerStatusValue } from "@t3tools/contracts";

/** T3's own check of a configured server; the seam the server check plugs into. */
export interface McpServerCheckSummary {
  readonly status: "connecting" | "connected" | "needs-auth" | "failed";
  readonly toolCount?: number;
  readonly error?: string;
}

export interface ThreadMcpRow {
  readonly name: string;
  readonly status: McpSessionServerStatusValue;
  readonly detail?: string;
  /** Shown beside an `unknown` session status when a server check exists. */
  readonly check?: { readonly status: McpServerCheckSummary["status"]; readonly detail?: string };
}

const toolCountDetail = (toolCount: number | undefined) =>
  toolCount === undefined ? undefined : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;

/**
 * Rows for the thread MCP tab. A provider that reported a list is authoritative
 * (it already includes skipped servers). One that reported nothing leaves each
 * configured server `unknown`, with the server check as the only signal.
 */
export function threadMcpRows(input: {
  readonly sessionServers: ReadonlyArray<McpSessionServerStatus> | null;
  readonly configuredNames: ReadonlyArray<string>;
  readonly serverCheckFor?: (name: string) => McpServerCheckSummary | undefined;
}): ReadonlyArray<ThreadMcpRow> {
  if (input.sessionServers !== null) {
    return input.sessionServers.map((server) => {
      const detail = server.error ?? toolCountDetail(server.toolCount);
      return {
        name: server.name,
        status: server.status,
        ...(detail === undefined ? {} : { detail }),
      };
    });
  }
  return input.configuredNames.toSorted().map((name): ThreadMcpRow => {
    const check = input.serverCheckFor?.(name);
    if (check === undefined) return { name, status: "unknown" };
    const detail = check.error ?? toolCountDetail(check.toolCount);
    return {
      name,
      status: "unknown",
      check: { status: check.status, ...(detail === undefined ? {} : { detail }) },
    };
  });
}

export const MCP_STATUS_LABELS: Readonly<Record<McpSessionServerStatusValue, string>> = {
  connecting: "Connecting",
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  disabled: "Disabled",
  unsupported: "Not supported by this provider",
  unknown: "Unknown",
};
