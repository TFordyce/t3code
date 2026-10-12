/**
 * The thread's MCP tab: which MCP servers the running provider session has and
 * the status it reports for each, including servers the adapter skipped. A
 * provider that reports nothing shows each configured server as unknown.
 *
 * @module ThreadMcpPanel
 */
import type { EnvironmentId, McpSessionServerStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  MCP_STATUS_LABELS,
  threadMcpRows,
  type McpServerCheckSummary,
} from "./ThreadMcpPanel.logic";

const STATUS_BADGE_VARIANT = {
  connecting: "info",
  connected: "success",
  "needs-auth": "warning",
  failed: "error",
  disabled: "secondary",
  unsupported: "secondary",
  unknown: "outline",
} as const;

export function ThreadMcpPanel(props: {
  readonly environmentId: EnvironmentId;
  /** The provider session's report, or `null` when it reported nothing. */
  readonly sessionServers: ReadonlyArray<McpSessionServerStatus> | null;
  /** The server check for a configured server, once checks exist. */
  readonly serverCheckFor?: (name: string) => McpServerCheckSummary | undefined;
}) {
  const configured = useEnvironmentSettings(props.environmentId, (settings) => settings.mcpServers);
  const rows = useMemo(
    () =>
      threadMcpRows({
        sessionServers: props.sessionServers,
        configuredNames: Object.keys(configured),
        ...(props.serverCheckFor === undefined ? {} : { serverCheckFor: props.serverCheckFor }),
      }),
    [configured, props.serverCheckFor, props.sessionServers],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">MCP servers</h2>
        <Button
          size="xs"
          variant="outline"
          render={<Link to="/settings/mcp" search={{ machine: props.environmentId }} />}
        >
          Manage MCP servers
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No MCP servers of your own in this session. The built-in T3 Code server is always
          available.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {rows.map((row) => (
            <li key={row.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{row.name}</div>
                {row.detail ? (
                  <div className="truncate text-xs text-muted-foreground">{row.detail}</div>
                ) : null}
                {row.check ? (
                  <div className="truncate text-xs text-muted-foreground">
                    Server check: {MCP_STATUS_LABELS[row.check.status]}
                    {row.check.detail ? ` · ${row.check.detail}` : ""}
                  </div>
                ) : null}
              </div>
              <Badge variant={STATUS_BADGE_VARIANT[row.status]}>
                {MCP_STATUS_LABELS[row.status]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
