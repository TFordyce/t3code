import type { ClaudeMcpServerStatusValue } from "@t3tools/contracts";

/**
 * What the Enable/Disable control on a Claude MCP row does. A disabled row
 * stays listed (status `disabled`) so the user can turn it back on; every other
 * status offers Disable.
 */
export function claudeMcpToggleFor(status: ClaudeMcpServerStatusValue): {
  readonly label: "Enable" | "Disable";
  /** The value to send as `enabled`. */
  readonly enable: boolean;
} {
  return status === "disabled"
    ? { label: "Enable", enable: true }
    : { label: "Disable", enable: false };
}
