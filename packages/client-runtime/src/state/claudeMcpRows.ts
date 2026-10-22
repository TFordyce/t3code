import { BUILT_IN_MCP_SERVER_NAME, type ClaudeMcpServerReport } from "@t3tools/contracts";

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

/** The user and org levels, in display order. Project and local servers belong to project pages. */
const GROUP_LABELS: ReadonlyArray<readonly [scope: string, label: string]> = [
  ["user", "User"],
  ["claudeai", "claude.ai"],
  ["managed", "Managed"],
  ["enterprise", "Enterprise"],
  ["plugin", "Plugins"],
  ["sdk", "SDK"],
];

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

const withGuidance = (report: ClaudeMcpServerReport): ClaudeMcpRow => {
  const row = toRow(report);
  if (report.status !== "needs-auth") return row;
  return {
    ...row,
    guidance:
      report.scope === "claudeai"
        ? { kind: "link", label: "Manage on claude.ai", href: CLAUDE_AI_CONNECTORS_URL }
        : { kind: "text", text: "Run /mcp in Claude Code to sign in." },
  };
};

/**
 * Claude's report as the MCP page shows it. A server whose name matches a
 * T3-configured one lands in `merged`, to sit beside that row's editable
 * controls; the rest are read-only, grouped by scope. `t3-code` is T3's own and
 * only tagged built in.
 */
export function claudeMcpView(input: {
  readonly servers: ReadonlyArray<ClaudeMcpServerReport>;
  readonly t3Names: ReadonlyArray<string>;
}): {
  readonly builtIn: ClaudeMcpRow | undefined;
  readonly merged: ReadonlyMap<string, ClaudeMcpRow>;
  readonly groups: ReadonlyArray<ClaudeMcpGroup>;
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
    } else if (GROUP_LABELS.some(([scope]) => scope === report.scope)) {
      const rows = byScope.get(report.scope!) ?? [];
      rows.push(withGuidance(report));
      byScope.set(report.scope!, rows);
    }
  }
  const groups = GROUP_LABELS.flatMap(([scope, label]): ClaudeMcpGroup[] => {
    const rows = byScope.get(scope);
    return rows === undefined
      ? []
      : [{ scope, label, rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)) }];
  });
  return { builtIn, merged, groups };
}

/**
 * Display names of enabled providers other than Claude. Only Claude reports its
 * loaded servers, so the page says the rest do not.
 */
export function unreportedProviderNames(
  providers: ReadonlyArray<{
    readonly driver: string;
    readonly enabled: boolean;
    readonly displayName?: string | undefined;
  }>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      providers
        .filter((provider) => provider.enabled && provider.driver !== "claudeAgent")
        .map((provider) => provider.displayName ?? provider.driver),
    ),
  ];
}
