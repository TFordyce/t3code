/**
 * The user and org MCP servers Claude has loaded, on Settings → MCP. Claude
 * reports them through a probe that starts its servers, so the page reads it on
 * mount and the query throttles automatic re-reads; Refresh asks Claude again.
 *
 * @module ClaudeMcpServers
 */
import type { EnvironmentId, ProjectId, ServerProvider, ThreadId } from "@t3tools/contracts";
import {
  claudeMcpProbeInput,
  claudeMcpView,
  unreportedProviderNames,
  type ClaudeMcpGroup,
  type ClaudeMcpRow,
} from "@t3tools/client-runtime/state/claude-mcp-rows";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { ClaudeMcpAddForm, ClaudeMcpAddedNotice } from "./ClaudeMcpAddForm";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ClaudeMcpReconnectButton } from "./ClaudeMcpReconnectButton";
import { ClaudeMcpServerDialog, TONE_CLASS } from "./ClaudeMcpServerDialog";
import { ClaudeMcpToggleButton } from "./ClaudeMcpToggleButton";
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
 * `refresh` asks Claude again past the server's probe cache, then re-reads
 * the list, which that fresh probe has just cached. `isPending` covers both.
 * `reload` only re-reads the list, for after the server has re-probed itself.
 */
export function useClaudeMcpStatus(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  /** The thread's project, so the probe sees its overrides; absent for the environment-wide list. */
  readonly projectId?: ProjectId | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly t3Names: ReadonlyArray<string>;
}) {
  const { environmentId, cwd, projectId, providers, t3Names } = input;
  const probes = cwd !== null && hasClaudeProvider(providers);
  const probeInput = probes ? claudeMcpProbeInput(cwd, projectId) : null;
  const query = useEnvironmentQuery(
    probeInput === null
      ? null
      : serverEnvironment.claudeMcpStatus({ environmentId, input: probeInput }),
  );
  const probeFresh = useAtomQueryRunner(serverEnvironment.claudeMcpStatus, {
    label: "refresh Claude MCP servers",
    refresh: true,
  });
  // The runner exposes no pending state, and reading the fresh atom to get one
  // would itself start a probe, so the in-flight fresh probe is tracked here.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (probeInput === null || refreshing) return;
    setRefreshing(true);
    void probeFresh({ environmentId, input: { ...probeInput, fresh: true } }).then((result) => {
      setRefreshing(false);
      if (AsyncResult.isSuccess(result)) query.refresh();
    });
  };
  const servers = query.data?.servers;
  const view = servers === undefined ? null : claudeMcpView({ servers, t3Names });
  return {
    probes,
    view,
    isPending: query.isPending || refreshing,
    error: query.error,
    refresh,
    reload: query.refresh,
  };
}

function Tone({ row }: { readonly row: ClaudeMcpRow }) {
  return <p className={`truncate text-xs ${TONE_CLASS[row.tone]}`}>{row.statusText}</p>;
}

/**
 * Claude's live status line, as it sits under a T3-configured or built-in row.
 * A failed server also gets Reconnect.
 */
export function ClaudeLiveStatus(props: {
  readonly row: ClaudeMcpRow | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId | undefined;
  readonly onReprobe?: (() => void) | undefined;
}) {
  const { row } = props;
  if (row === undefined) return null;
  return (
    <div className="flex items-center gap-2">
      <Tone row={row} />
      {row.status === "failed" ? (
        <ClaudeMcpReconnectButton
          environmentId={props.environmentId}
          threadId={props.threadId}
          name={row.name}
          onReprobe={props.onReprobe}
        />
      ) : null}
    </div>
  );
}

/**
 * Claude-only servers grouped by scope, each with its Enable/Disable control
 * and, when failed, Reconnect. `onReprobe` asks Claude again; it runs after
 * a reconnect or toggle, and is Reconnect itself without a `threadId`; pass
 * `probing` while it runs. With `cwd`, the directory the list was probed in,
 * clicking a row opens its detail dialog.
 */
export function ClaudeMcpGroups(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly onReprobe?: (() => void) | undefined;
  readonly probing?: boolean | undefined;
  readonly groups: ReadonlyArray<ClaudeMcpGroup>;
}) {
  const [openName, setOpenName] = useState<string | null>(null);
  const { cwd } = props;
  return (
    <>
      {cwd === undefined ? null : (
        <ClaudeMcpServerDialog
          environmentId={props.environmentId}
          cwd={cwd}
          projectId={props.projectId}
          threadId={props.threadId}
          onReprobe={props.onReprobe}
          probing={props.probing}
          name={openName}
          onClose={() => setOpenName(null)}
        />
      )}
      {props.groups.map((group) => (
        <div key={group.scope}>
          <h3 className="px-3 pt-3 text-xs font-medium text-muted-foreground sm:px-4">
            {group.label}
          </h3>
          <SettingsGroup variant="plain">
            {group.rows.map((row) => (
              <div
                key={row.name}
                className="flex items-center justify-between gap-3 px-3 py-2 sm:px-4"
              >
                <div className="min-w-0">
                  {cwd === undefined ? (
                    <>
                      <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                      <Tone row={row} />
                    </>
                  ) : (
                    <button
                      type="button"
                      className="block w-full min-w-0 cursor-pointer text-left"
                      onClick={() => setOpenName(row.name)}
                    >
                      <p className="truncate text-sm font-medium text-foreground hover:underline">
                        {row.name}
                      </p>
                      <Tone row={row} />
                    </button>
                  )}
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
                <div className="flex shrink-0 items-center gap-2">
                  {row.status === "failed" ? (
                    <ClaudeMcpReconnectButton
                      environmentId={props.environmentId}
                      threadId={props.threadId}
                      name={row.name}
                      onReprobe={props.onReprobe}
                    />
                  ) : null}
                  <ClaudeMcpToggleButton
                    environmentId={props.environmentId}
                    projectId={props.projectId}
                    name={row.name}
                    status={row.status}
                    onToggled={props.onReprobe}
                  />
                </div>
              </div>
            ))}
          </SettingsGroup>
        </div>
      ))}
    </>
  );
}

export function ClaudeMcpSection(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  /** A selected project: `cwd` is its root, Local scope is offered, and its project servers show. */
  readonly projectId?: ProjectId | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly t3Names: ReadonlyArray<string>;
}) {
  const { probes, view, isPending, error, refresh, reload } = useClaudeMcpStatus(props);
  const canAdd = useAtomValue(
    serverEnvironment.addClaudeMcpServer.permissionAtom(props.environmentId),
  );
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const unreported = unreportedProviderNames(props.providers);
  if (!probes && unreported.length === 0) return null;
  const { cwd } = props;
  const groups =
    view === null
      ? []
      : props.projectId === undefined
        ? view.groups
        : [...view.projectGroups, ...view.groups];

  return (
    <SettingsSection
      title="Claude's servers"
      headerAction={
        probes ? (
          <div className="flex items-center gap-2">
            {canAdd && cwd !== null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={adding}
                onClick={() => {
                  setAdded(null);
                  setAdding(true);
                }}
              >
                <PlusIcon aria-hidden />
                Add server
              </Button>
            ) : null}
            <Button size="xs" variant="outline" disabled={isPending} onClick={refresh}>
              Refresh
            </Button>
          </div>
        ) : null
      }
    >
      {adding && cwd !== null ? (
        <div className="px-3 py-3 sm:px-4">
          <ClaudeMcpAddForm
            environmentId={props.environmentId}
            cwd={cwd}
            projectId={props.projectId}
            scopes={props.projectId === undefined ? ["user"] : ["local", "user"]}
            t3Names={props.t3Names}
            onCancel={() => setAdding(false)}
            onAdded={(name) => {
              setAdding(false);
              setAdded(name);
              reload();
            }}
          />
        </div>
      ) : null}
      {added === null ? null : (
        <div className="px-3 py-3 sm:px-4">
          <ClaudeMcpAddedNotice name={added} onDismiss={() => setAdded(null)} />
        </div>
      )}
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
      {view ? (
        <ClaudeMcpGroups
          environmentId={props.environmentId}
          cwd={props.cwd ?? undefined}
          projectId={props.projectId}
          groups={groups}
          onReprobe={refresh}
          probing={isPending}
        />
      ) : null}
      {view !== null && groups.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {props.projectId === undefined
            ? "Claude has no user or org servers loaded."
            : "Claude has no servers loaded for this project."}
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
