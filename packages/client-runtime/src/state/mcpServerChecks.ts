import type { McpServerCheck, ServerConfig } from "@t3tools/contracts";

/** The check of one entry, if the environment has reported one. */
export function selectMcpServerCheck(
  config: Pick<ServerConfig, "mcpServerChecks"> | null | undefined,
  scope: string,
  name: string,
): McpServerCheck | undefined {
  return config?.mcpServerChecks?.find((check) => check.scope === scope && check.name === name);
}

/** The words a row shows for its check; undefined means no check has run. */
export function describeMcpServerCheck(check: McpServerCheck | undefined): string {
  if (check === undefined) return "Not checked yet";
  switch (check.status) {
    case "checking":
      return "Checking...";
    case "connected":
      return check.toolCount === undefined
        ? "Connected"
        : `Connected · ${check.toolCount} ${check.toolCount === 1 ? "tool" : "tools"}`;
    case "needs-auth":
      return "Needs sign-in";
    case "failed":
      return check.error === undefined ? "Failed" : `Failed · ${check.error}`;
  }
}
