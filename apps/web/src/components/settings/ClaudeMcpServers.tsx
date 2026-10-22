/**
 * The user and org MCP servers Claude has loaded, on Settings → MCP. Claude
 * reports them through a probe that starts its servers, so the page reads it on
 * mount and the query throttles automatic re-reads; Refresh always asks again.
 *
 * @module ClaudeMcpServers
 */
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  claudeMcpView,
  unreportedProviderNames,
  type ClaudeMcpRow,
} from "@t3tools/client-runtime/state/claude-mcp-rows";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";

/** Whether this environment has a Claude provider that can answer the probe. */
const hasClaudeProvider = (providers: ReadonlyArray<ServerProvider>) =>
  providers.some(
    (provider) =>
      provider.driver === "claudeAgent" &&
      provider.enabled &&
      (provider.status === "ready" || provider.status === "warning"),
  );

/**
 * Claude's report for an environment, read on mount. `cwd` is the directory
 * Claude is started in; null (or no Claude provider) skips the probe.
 */
export function useClaudeMcpStatus(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly t3Names: ReadonlyArray<string>;
}) {
  const { environmentId, cwd, providers, t3Names } = input;
  const probes = cwd !== null && hasClaudeProvider(providers);
  const query = useEnvironmentQuery(
    probes ? serverEnvironment.claudeMcpStatus({ environmentId, input: { cwd } }) : null,
  );
  const servers = query.data?.servers;
  const view = servers === undefined ? null : claudeMcpView({ servers, t3Names });
  return { probes, view, isPending: query.isPending, error: query.error, refresh: query.refresh };
}

function Tone({ row }: { readonly row: ClaudeMcpRow }) {
  return (
    <p
      className={
        row.tone === "error"
          ? "truncate text-xs text-destructive"
          : row.tone === "warning"
            ? "truncate text-xs text-warning-foreground"
            : "truncate text-xs text-muted-foreground"
      }
    >
      {row.statusText}
    </p>
  );
}

/** Claude's live status line, as it sits under a T3-configured or built-in row. */
export function ClaudeLiveStatus({ row }: { readonly row: ClaudeMcpRow | undefined }) {
  if (row === undefined) return null;
  return (
    <div>
      <Tone row={row} />
    </div>
  );
}

export function ClaudeMcpSection(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly t3Names: ReadonlyArray<string>;
}) {
  const { probes, view, isPending, error, refresh } = useClaudeMcpStatus(props);
  const unreported = unreportedProviderNames(props.providers);
  if (!probes && unreported.length === 0) return null;

  return (
    <SettingsSection
      title="Claude's servers"
      headerAction={
        probes ? (
          <Button size="xs" variant="outline" disabled={isPending} onClick={refresh}>
            Refresh
          </Button>
        ) : null
      }
    >
      {probes && view === null && isPending ? (
        <div className="flex items-center gap-2 px-3 py-3 text-sm sm:px-4">
          <Spinner className="size-3.5" />
          <span className="text-muted-foreground">Asking Claude which servers it loaded...</span>
        </div>
      ) : null}
      {probes && error !== null && view === null ? (
        <div className="px-3 py-3 sm:px-4">
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      {view?.groups.map((group) => (
        <div key={group.scope}>
          <h3 className="px-3 pt-3 text-xs font-medium text-muted-foreground sm:px-4">
            {group.label}
          </h3>
          <SettingsGroup variant="plain">
            {group.rows.map((row) => (
              <div key={row.name} className="px-3 py-2 sm:px-4">
                <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                <Tone row={row} />
                {row.guidance?.kind === "link" ? (
                  <a
                    className="text-xs text-info-foreground underline"
                    href={row.guidance.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.guidance.label}
                  </a>
                ) : row.guidance ? (
                  <p className="text-xs text-muted-foreground">{row.guidance.text}</p>
                ) : null}
              </div>
            ))}
          </SettingsGroup>
        </div>
      ))}
      {view !== null && view.groups.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          Claude has no user or org servers loaded.
        </p>
      ) : null}
      {unreported.length > 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          {unreported.join(", ")}: not reported by this provider.
        </p>
      ) : null}
    </SettingsSection>
  );
}
