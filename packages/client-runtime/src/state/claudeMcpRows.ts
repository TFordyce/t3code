import {
  BUILT_IN_MCP_SERVER_NAME,
  type ClaudeMcpServerDetail,
  type ClaudeMcpServerDetailResult,
  type ClaudeMcpServerReport,
  type ClaudeMcpTransportKind,
} from "@t3tools/contracts";

export type ClaudeMcpTone = "neutral" | "success" | "warning" | "error";

export type ClaudeMcpGuidance =
  | { readonly kind: "link"; readonly label: string; readonly href: string }
  | { readonly kind: "text"; readonly text: string };

/** One server as Claude reports it, with the words a row shows for it. */
export interface ClaudeMcpRow {
  readonly name: string;
  readonly status: ClaudeMcpServerReport["status"];
  readonly statusText: string;
  readonly tone: ClaudeMcpTone;
  /** Only on Claude-only rows that need sign-in; T3's own sign-in covers merged rows. */
  readonly guidance?: ClaudeMcpGuidance;
}

export interface ClaudeMcpGroup {
  readonly scope: string;
  readonly label: string;
  readonly rows: ReadonlyArray<ClaudeMcpRow>;
}

/** Servers that depend on the project directory Claude was started in; the thread panel shows these. */
const PROJECT_GROUP_LABELS: ReadonlyArray<readonly [scope: string, label: string]> = [
  ["project", "Project"],
  ["local", "Local"],
  ["dynamic", "Dynamic"],
  ["agent", "Agent"],
];

/** The user and org levels, in display order, for Settings. */
const GROUP_LABELS: ReadonlyArray<readonly [scope: string, label: string]> = [
  ["user", "User"],
  ["claudeai", "claude.ai"],
  ["managed", "Managed"],
  ["enterprise", "Enterprise"],
  ["plugin", "Plugins"],
  ["sdk", "SDK"],
];

/** Where servers with no scope, or one this list does not know, land so they never vanish. */
const OTHER_SCOPE = "other";
const OTHER_GROUP_LABEL: readonly [scope: string, label: string] = [OTHER_SCOPE, "Other"];

const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

const TONES: Record<ClaudeMcpServerReport["status"], ClaudeMcpTone> = {
  connected: "success",
  pending: "neutral",
  failed: "error",
  "needs-auth": "warning",
  disabled: "neutral",
};

function describeReport(report: ClaudeMcpServerReport): string {
  switch (report.status) {
    case "connected":
      return `Connected · ${report.toolCount} ${report.toolCount === 1 ? "tool" : "tools"}`;
    case "pending":
      return "Connecting...";
    case "needs-auth":
      return "Needs sign-in";
    case "disabled":
      return "Disabled";
    case "failed":
      return report.error === undefined || report.error.length === 0
        ? "Failed"
        : `Failed · ${report.error}`;
  }
}

const toRow = (report: ClaudeMcpServerReport): ClaudeMcpRow => ({
  name: report.name,
  status: report.status,
  statusText: describeReport(report),
  tone: TONES[report.status],
});

const MANAGE_ON_CLAUDE_AI: ClaudeMcpGuidance = {
  kind: "link",
  label: "Manage on claude.ai",
  href: CLAUDE_AI_CONNECTORS_URL,
};
const SIGN_IN_WITH_MCP: ClaudeMcpGuidance = {
  kind: "text",
  text: "Run /mcp in Claude Code to sign in.",
};
const CLEAR_SIGN_IN_WITH_MCP: ClaudeMcpGuidance = {
  kind: "text",
  text: "Run /mcp in Claude Code to clear sign-in.",
};

const withGuidance = (report: ClaudeMcpServerReport): ClaudeMcpRow => {
  const row = toRow(report);
  if (report.status !== "needs-auth") return row;
  return {
    ...row,
    guidance: report.scope === "claudeai" ? MANAGE_ON_CLAUDE_AI : SIGN_IN_WITH_MCP,
  };
};

/**
 * Claude's report as the MCP page shows it. A server whose name matches a
 * T3-configured one lands in `merged`, to sit beside that row's editable
 * controls; the rest are grouped by scope, with unscoped or unrecognised ones
 * under "Other". `t3-code` is T3's own and
 * only tagged built in.
 */
export function claudeMcpView(input: {
  readonly servers: ReadonlyArray<ClaudeMcpServerReport>;
  readonly t3Names: ReadonlyArray<string>;
}): {
  readonly builtIn: ClaudeMcpRow | undefined;
  readonly merged: ReadonlyMap<string, ClaudeMcpRow>;
  readonly groups: ReadonlyArray<ClaudeMcpGroup>;
  /** Project-level servers (project, local, dynamic, agent), for the thread panel. */
  readonly projectGroups: ReadonlyArray<ClaudeMcpGroup>;
} {
  const t3Names = new Set(input.t3Names);
  let builtIn: ClaudeMcpRow | undefined;
  const merged = new Map<string, ClaudeMcpRow>();
  const byScope = new Map<string, ClaudeMcpRow[]>();
  for (const report of input.servers) {
    if (report.name === BUILT_IN_MCP_SERVER_NAME) {
      builtIn = toRow(report);
    } else if (t3Names.has(report.name)) {
      merged.set(report.name, toRow(report));
    } else {
      const known = [...GROUP_LABELS, ...PROJECT_GROUP_LABELS].some(
        ([scope]) => scope === report.scope,
      );
      const scope = known ? report.scope! : OTHER_SCOPE;
      const rows = byScope.get(scope) ?? [];
      rows.push(withGuidance(report));
      byScope.set(scope, rows);
    }
  }
  const toGroups = (labels: typeof GROUP_LABELS) =>
    labels.flatMap(([scope, label]): ClaudeMcpGroup[] => {
      const rows = byScope.get(scope);
      return rows === undefined
        ? []
        : [{ scope, label, rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)) }];
    });
  return {
    builtIn,
    merged,
    groups: toGroups([...GROUP_LABELS, OTHER_GROUP_LABEL]),
    projectGroups: toGroups(PROJECT_GROUP_LABELS),
  };
}

/**
 * Display names of enabled providers other than Claude that carry user MCP
 * servers. Only Claude reports its loaded servers, so the page says the rest do
 * not; a provider with no MCP support (Grok, Antigravity) is not named.
 */
export function unreportedProviderNames(
  providers: ReadonlyArray<{
    readonly driver: string;
    readonly enabled: boolean;
    readonly displayName?: string | undefined;
    readonly userMcpTransports?: ReadonlyArray<string> | undefined;
  }>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      providers
        .filter(
          (provider) =>
            provider.enabled &&
            provider.driver !== "claudeAgent" &&
            (provider.userMcpTransports?.length ?? 0) > 0,
        )
        .map((provider) => provider.displayName ?? provider.driver),
    ),
  ];
}

const STATUS_TEXT: Record<ClaudeMcpServerReport["status"], string> = {
  connected: "Connected",
  pending: "Connecting...",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  disabled: "Disabled",
};

const TRANSPORT_LABELS: Record<ClaudeMcpTransportKind, string> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE",
  claudeai: "claude.ai",
  sdk: "SDK",
};

const SCOPE_LABELS: Record<string, string> = {
  user: "User",
  project: "Project",
  local: "Local",
  dynamic: "Dynamic",
  agent: "Agent",
  claudeai: "claude.ai",
  managed: "Managed",
  enterprise: "Enterprise",
  plugin: "Plugin",
  sdk: "SDK",
};

const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

function locationOf(server: ClaudeMcpServerDetail): string | undefined {
  if (server.scope === undefined) {
    return server.source === undefined ? undefined : scopeLabel(server.source);
  }
  const scope = scopeLabel(server.scope);
  return server.source === undefined || server.source === server.scope
    ? scope
    : `${scope} (from ${scopeLabel(server.source)})`;
}

/**
 * A control the detail dialog offers. Reconnect is a fresh probe on Settings
 * and a live reconnect of the running Claude process in a thread; the toggle
 * uses the same project-or-environment scope as the row button.
 */
export type ClaudeMcpDetailAction = "reconnect" | "enable" | "disable";

const actionsFor = (
  status: ClaudeMcpServerReport["status"],
): ReadonlyArray<ClaudeMcpDetailAction> =>
  status === "disabled" ? ["enable"] : ["reconnect", "disable"];

/**
 * Where a server's sign-in lives. Claude owns it, so T3 only points there:
 * claude.ai for connectors, `/mcp` for other remote servers. stdio and SDK
 * servers have no sign-in.
 */
function detailGuidance(server: ClaudeMcpServerDetail): ClaudeMcpGuidance | undefined {
  if (server.transport === "claudeai") return MANAGE_ON_CLAUDE_AI;
  if (server.transport !== "http" && server.transport !== "sse") return undefined;
  switch (server.status) {
    case "needs-auth":
      return SIGN_IN_WITH_MCP;
    case "connected":
      return CLEAR_SIGN_IN_WITH_MCP;
    default:
      return undefined;
  }
}

/** What the Claude MCP server detail dialog shows, from its detail query. */
export type ClaudeMcpDetailView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  /** The server dropped out of Claude's report; the dialog offers only Close. */
  | { readonly kind: "missing"; readonly message: string }
  | {
      readonly kind: "server";
      /** Claude is being asked again; the fields are the last answer. */
      readonly refreshing: boolean;
      readonly name: string;
      readonly status: ClaudeMcpServerReport["status"];
      readonly statusText: string;
      readonly tone: ClaudeMcpTone;
      readonly error?: string;
      /** The server's own name and version, only while connected. */
      readonly serverInfo?: string;
      readonly transport?: string;
      /** The query-stripped URL for remote servers, or the stdio command name. */
      readonly target?: string;
      /** The config scope, plus the source when it differs. */
      readonly location?: string;
      readonly toolCountText: string;
      readonly guidance?: ClaudeMcpGuidance;
      readonly tools: ReadonlyArray<ClaudeMcpToolView>;
      /** Set only when `tools` is empty: says whether the server has none or Claude can't list them yet. */
      readonly noToolsText?: string;
      /** In display order; the caller hides them without the providers-manage grant. */
      readonly actions: ReadonlyArray<ClaudeMcpDetailAction>;
    };

/**
 * The detail dialog's state. A server Claude stops reporting turns into
 * `missing` rather than vanishing; an earlier answer stays on screen (marked
 * `refreshing`) while a new probe runs.
 */
export function claudeMcpDetailView(input: {
  readonly data: ClaudeMcpServerDetailResult | null | undefined;
  readonly isPending: boolean;
  readonly error: string | null;
}): ClaudeMcpDetailView {
  const { data } = input;
  if (data === null || data === undefined) {
    return input.error !== null && !input.isPending
      ? { kind: "error", message: input.error }
      : { kind: "loading" };
  }
  const server = data.server;
  if (server === null) {
    return { kind: "missing", message: "Claude no longer reports this server" };
  }
  const target = server.url ?? server.command;
  const location = locationOf(server);
  const guidance = detailGuidance(server);
  return {
    kind: "server",
    refreshing: input.isPending,
    name: server.name,
    status: server.status,
    statusText: STATUS_TEXT[server.status],
    tone: TONES[server.status],
    ...(server.error === undefined || server.error.length === 0 ? {} : { error: server.error }),
    ...(server.status !== "connected" || server.serverInfo === undefined
      ? {}
      : { serverInfo: `${server.serverInfo.name} ${server.serverInfo.version}` }),
    ...(server.transport === undefined ? {} : { transport: TRANSPORT_LABELS[server.transport] }),
    ...(target === undefined ? {} : { target }),
    ...(location === undefined ? {} : { location }),
    toolCountText: `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`,
    ...(guidance === undefined ? {} : { guidance }),
    tools: server.tools.map(toToolView),
    ...(server.tools.length > 0 ? {} : { noToolsText: noToolsText(server.status) }),
    actions: actionsFor(server.status),
  };
}

function noToolsText(status: ClaudeMcpServerReport["status"]): string {
  switch (status) {
    case "connected":
      return "This server offers no tools.";
    case "disabled":
      return "Enable this server to see its tools.";
    default:
      return "Claude lists this server's tools once it connects.";
  }
}

/**
 * One tool in the dialog's "View tools" list. The text is the server author's
 * and is shown as plain text: `summary` is its first line, `description` the
 * whole of it for expanding.
 */
export interface ClaudeMcpToolView {
  readonly name: string;
  readonly summary?: string;
  readonly description?: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
}

function toToolView(tool: ClaudeMcpServerDetail["tools"][number]): ClaudeMcpToolView {
  const description = tool.description?.trim() ?? "";
  const summary = description.split("\n", 1)[0]?.trim() ?? "";
  return {
    name: tool.name,
    ...(description.length === 0 ? {} : { summary, description }),
    readOnly: tool.readOnly,
    destructive: tool.destructive,
  };
}
