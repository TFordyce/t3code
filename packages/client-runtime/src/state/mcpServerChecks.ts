import type { McpServerCheck, McpServerConfig, ServerConfig } from "@t3tools/contracts";

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
      return check.auth === "expired" ? "Sign-in expired" : "Needs sign-in";
    case "failed":
      return check.error === undefined ? "Failed" : `Failed · ${check.error}`;
  }
}

export type McpSignInControl =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "sign-in"; readonly label: "Sign in" | "Sign in again" }
  | { readonly kind: "signed-in" };

/**
 * What a row offers for OAuth. Sign-in appears once the server has shown OAuth
 * (it asked for sign-in or has a sign-in), and an entry's own `Authorization`
 * header takes precedence, so the row asks for it to be removed instead.
 */
export function mcpSignInControl(
  config: McpServerConfig,
  check: McpServerCheck | undefined,
): McpSignInControl {
  if (config.transport !== "http") return { kind: "none" };
  if (check?.auth === undefined && check?.status !== "needs-auth") return { kind: "none" };
  if (config.headers.some((row) => row.name.toLowerCase() === "authorization")) {
    return { kind: "blocked", message: "Remove the Authorization header to sign in." };
  }
  if (check.auth === "signed-in") return { kind: "signed-in" };
  return { kind: "sign-in", label: check.auth === "expired" ? "Sign in again" : "Sign in" };
}
