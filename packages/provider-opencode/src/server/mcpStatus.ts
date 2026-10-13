import type { McpSessionServerStatus } from "@t3tools/contracts";

/** OpenCode's connection status for one MCP server, as session MCP status. */
export function openCodeMcpStatus(status: {
  readonly status: string;
  readonly error?: string;
}): Omit<McpSessionServerStatus, "name"> {
  switch (status.status) {
    case "pending":
      return { status: "connecting" };
    case "connected":
      return { status: "connected" };
    case "disabled":
      return { status: "disabled" };
    case "needs_auth":
    case "needs_client_registration":
      return { status: "needs-auth" };
    case "failed":
      return { status: "failed", ...(status.error === undefined ? {} : { error: status.error }) };
    default:
      return { status: "unknown" };
  }
}
