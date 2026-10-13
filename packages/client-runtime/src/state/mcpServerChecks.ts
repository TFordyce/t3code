import {
  isMcpServerDisabledMarker,
  type McpServerCheck,
  type McpServerConfig,
  type McpSessionServerStatus,
  type McpSessionServerStatusValue,
  type ProjectId,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";

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

/** One row in a project's own section: its servers and its overrides of environment ones. */
export interface ProjectMcpRow {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly kind: "project" | "override";
}

/** An environment server as a project sees it. */
export interface InheritedMcpRow {
  readonly name: string;
  readonly config: McpServerConfig;
  /** The project has a marker turning it off. */
  readonly offForProject: boolean;
  /** Off at environment level, so the project switch is inert. */
  readonly offOnEnvironment: boolean;
}

type McpSettingsView = Pick<ServerSettings, "mcpServers" | "projectSettingsOverrides">;

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name.localeCompare(right.name);

/**
 * The rows of a project's MCP page: what the project holds itself ("This
 * project") and the environment servers it inherits, in name order.
 */
export function projectMcpRows(
  settings: McpSettingsView,
  projectId: ProjectId,
): {
  readonly project: ReadonlyArray<ProjectMcpRow>;
  readonly inherited: ReadonlyArray<InheritedMcpRow>;
} {
  const overrides = settings.projectSettingsOverrides[projectId]?.mcpServers ?? {};
  const project: ProjectMcpRow[] = [];
  const inherited: InheritedMcpRow[] = [];
  for (const [name, override] of Object.entries(overrides)) {
    if (isMcpServerDisabledMarker(override)) continue;
    project.push({
      name,
      config: override,
      kind: Object.hasOwn(settings.mcpServers, name) ? "override" : "project",
    });
  }
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    const override = overrides[name];
    if (override !== undefined && !isMcpServerDisabledMarker(override)) continue;
    inherited.push({
      name,
      config,
      offForProject: override !== undefined,
      offOnEnvironment: config.enabled === false,
    });
  }
  return { project: project.slice().sort(byName), inherited: inherited.slice().sort(byName) };
}

export type McpRowTone = "neutral" | "success" | "warning" | "error";

/** A flat, read-only row of the effective MCP server list, as mobile shows it. */
export interface McpServerListRow {
  readonly name: string;
  /** Where the entry comes from; only meaningful to show in project scope. */
  readonly source: "environment" | "project" | "override";
  readonly transport: McpServerConfig["transport"];
  /** The command line or URL. Env values and headers are never part of it. */
  readonly target: string;
  /** Whether the entry is in the effective set. */
  readonly enabled: boolean;
  readonly check: McpServerCheck | undefined;
  readonly statusText: string;
  readonly tone: McpRowTone;
  /** What a read-only client says about OAuth sign-in, where the server shows it. */
  readonly signInNote?: string;
}

const checkTone = (check: McpServerCheck | undefined): McpRowTone => {
  switch (check?.status) {
    case "connected":
      return "success";
    case "needs-auth":
      return "warning";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
};

const describeTarget = (config: McpServerConfig) =>
  config.transport === "http" ? config.url : [config.command, ...config.args].join(" ");

/**
 * The effective MCP server list for an environment, or for one project in it:
 * the project's own entries and overrides first, then the environment servers
 * it inherits (with the reason it is off in place of a check).
 */
export function mcpServerListRows(input: {
  readonly settings: McpSettingsView;
  readonly config: Pick<ServerConfig, "mcpServerChecks"> | null | undefined;
  readonly projectId: ProjectId | null;
}): ReadonlyArray<McpServerListRow> {
  const row = (
    name: string,
    config: McpServerConfig,
    source: McpServerListRow["source"],
    offText: string | null,
  ): McpServerListRow => {
    const scope = source === "environment" ? "global" : (input.projectId ?? "global");
    const check = selectMcpServerCheck(input.config, scope, name);
    const base = {
      name,
      source,
      transport: config.transport,
      target: describeTarget(config),
      check,
    };
    if (offText !== null) {
      return { ...base, enabled: false, statusText: offText, tone: "neutral" };
    }
    const control = mcpSignInControl(config, check);
    const signInNote =
      control.kind === "sign-in"
        ? "Sign in from desktop or web"
        : control.kind === "signed-in"
          ? "Signed in"
          : undefined;
    return {
      ...base,
      enabled: true,
      statusText: describeMcpServerCheck(check),
      tone: checkTone(check),
      ...(signInNote === undefined ? {} : { signInNote }),
    };
  };
  const offOwn = (config: McpServerConfig) => (config.enabled === false ? "Off" : null);

  if (input.projectId === null) {
    return Object.entries(input.settings.mcpServers)
      .map(([name, config]) => row(name, config, "environment", offOwn(config)))
      .slice()
      .sort(byName);
  }
  const { project, inherited } = projectMcpRows(input.settings, input.projectId);
  return [
    ...project.map((entry) => row(entry.name, entry.config, entry.kind, offOwn(entry.config))),
    ...inherited.map((entry) =>
      row(
        entry.name,
        entry.config,
        "environment",
        entry.offForProject
          ? "Off for this project"
          : entry.offOnEnvironment
            ? "Off on environment"
            : null,
      ),
    ),
  ];
}

/** T3's own check of a configured server; the thread MCP view falls back to it. */
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
 * Rows for a thread's MCP view. A provider that reported a list is authoritative
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
  return [...input.configuredNames].sort().map((name): ThreadMcpRow => {
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

/**
 * What the thread MCP view falls back to when the provider reports no session
 * status: the servers in the thread's effective set, with their server checks.
 */
export function mcpThreadFallback(rows: ReadonlyArray<McpServerListRow>): {
  readonly configuredNames: ReadonlyArray<string>;
  readonly serverCheckFor: (name: string) => McpServerCheckSummary | undefined;
} {
  const enabled = rows.filter((row) => row.enabled);
  return {
    configuredNames: enabled.map((row) => row.name),
    serverCheckFor: (name) => {
      const check = enabled.find((row) => row.name === name)?.check;
      if (check === undefined) return undefined;
      return {
        status: check.status === "checking" ? "connecting" : check.status,
        ...(check.toolCount === undefined ? {} : { toolCount: check.toolCount }),
        ...(check.error === undefined ? {} : { error: check.error }),
      };
    },
  };
}
