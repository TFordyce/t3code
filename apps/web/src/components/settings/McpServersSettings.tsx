/**
 * Settings → MCP servers. Lists the user MCP servers an environment hands to
 * every provider session, beside the built-in `t3-code` one, and edits them in
 * place. At project scope it shows the project's own servers and overrides
 * above the environment servers it inherits. Secret env values are stored on
 * the host; this page only ever sees a "stored securely" marker for them.
 *
 * @module McpServersSettings
 */
import type {
  EnvironmentId,
  McpServerCheck,
  McpServerConfig,
  McpServerOverride,
  ProjectId,
  ServerProvider,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  describeMcpServerCheck,
  mcpSignInControl,
  selectMcpServerCheck,
} from "@t3tools/client-runtime/state/mcp-server-checks";
import type { ClaudeMcpRow } from "@t3tools/client-runtime/state/claude-mcp-rows";
import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  overrideDraftFromEnvironment,
  projectMcpPatch,
  projectMcpRows,
  providersWithoutMcpSupport,
  relayMcpSignIn,
  saveNotice,
  selectProjectMcpCheck,
  urlQueryTokenWarning,
  validateDraft,
  type InheritedMcpRow,
  type McpEnvDraftRow,
  type McpServerDraft,
} from "./McpServersSettings.logic";
import { ClaudeLiveStatus, ClaudeMcpSection, useClaudeMcpStatus } from "./ClaudeMcpServers";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const APPROVAL_NOTE = "Tool calls go through each provider's normal approval.";

export function McpServersSettingsPanel() {
  const { environment, scope, target } = useSettingsScope();
  if (environment === null) {
    return (
      <SettingsScopeNotice target="environment">
        Connect an environment to manage its MCP servers.
      </SettingsScopeNotice>
    );
  }
  return (
    <McpServersEnvironmentPanel
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      projectScoped={scope.kind === "project" || scope.kind === "checkout"}
      projectId={
        target?.projectId != null && target.environmentId === environment.environmentId
          ? target.projectId
          : null
      }
    />
  );
}

function McpServersEnvironmentPanel({
  environmentId,
  environmentLabel,
  projectScoped,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectScoped: boolean;
  readonly projectId: ProjectId | null;
}) {
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.mcpServers);
  const projectOverrides = useEnvironmentSettings(
    environmentId,
    (settings) => settings.projectSettingsOverrides,
  );
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canManage = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch:
        projectId === null ? { mcpServers: {} } : { mcpServers: {}, projectSettingsOverrides: {} },
    }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update MCP servers",
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canCheck = useAtomValue(serverEnvironment.checkMcpServers.permissionAtom(environmentId));
  const checkServers = useAtomCommand(serverEnvironment.checkMcpServers, {
    label: "check MCP servers",
  });
  const claude = useClaudeMcpStatus({
    environmentId,
    cwd: projectId === null ? (serverConfig?.cwd ?? null) : null,
    providers,
    t3Names: Object.keys(servers).toSorted(),
  });
  const [adding, setAdding] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const names = Object.keys(servers).toSorted();
  const rows =
    projectId === null
      ? null
      : projectMcpRows(
          { mcpServers: servers, projectSettingsOverrides: projectOverrides },
          projectId,
        );

  /** Resolves true when the server accepted the change. */
  const save = async (name: string, config: McpServerConfig | null) => {
    const patch: ServerSettingsPatch = { mcpServers: { [name]: config } };
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag !== "Success") return false;
    setNoticeVisible(true);
    return true;
  };

  /** Writes one entry of the project's MCP overrides; null removes it. */
  const saveProject = async (name: string, value: McpServerOverride | null) => {
    if (projectId === null) return false;
    const patch: ServerSettingsPatch = projectMcpPatch(
      { projectSettingsOverrides: projectOverrides },
      projectId,
      name,
      value,
    );
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag !== "Success") return false;
    setNoticeVisible(true);
    return true;
  };

  if (projectId !== null && rows !== null) {
    const allNames = [...new Set([...names, ...rows.project.map((row) => row.name)])];
    return (
      <SettingsPageContainer>
        {noticeVisible ? (
          <Alert variant="success">
            <AlertDescription>{saveNotice(providers, "project")}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="ghost" onClick={() => setNoticeVisible(false)}>
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        <SettingsSection
          {...searchableSetting("mcp-servers")}
          headerAction={
            canManage ? (
              <Button size="xs" variant="outline" disabled={adding} onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden />
                Add server
              </Button>
            ) : null
          }
        >
          <h3 className="px-3 text-xs font-medium text-muted-foreground sm:px-4">This project</h3>
          <SettingsGroup>
            {adding ? (
              <div className="px-3 py-3 sm:px-4">
                <McpServerForm
                  isNew
                  initial={emptyDraft()}
                  existingNames={allNames}
                  providers={providers}
                  onCancel={() => setAdding(false)}
                  onSave={async (draft) => {
                    if (await saveProject(draft.name, configFromDraft(draft))) setAdding(false);
                  }}
                />
              </div>
            ) : null}
            {rows.project.map((row) => (
              <McpServerRow
                key={row.name}
                name={row.name}
                config={row.config}
                existingNames={allNames}
                providers={providers}
                badge={
                  <Badge variant="secondary">
                    {row.kind === "override" ? "Overridden" : "Project"}
                  </Badge>
                }
                check={selectProjectMcpCheck(serverConfig, projectId, row.name, row.kind)}
                environmentLabel={environmentLabel}
                canCheck={canCheck}
                signIn={{ environmentId, target: { scope: projectId, name: row.name }, canManage }}
                onCheck={() =>
                  void checkServers({
                    environmentId,
                    input: { targets: [{ scope: projectId, name: row.name }] },
                  })
                }
                readOnly={!canManage}
                onSave={(next) => saveProject(row.name, next)}
                onRemove={row.kind === "project" ? () => saveProject(row.name, null) : undefined}
                onUseEnvironmentConfig={
                  row.kind === "override" ? () => saveProject(row.name, null) : undefined
                }
              />
            ))}
          </SettingsGroup>
          {rows.project.length === 0 && !adding ? (
            <p className="px-3 text-sm text-muted-foreground sm:px-4">
              This project has no servers of its own. Add one, or override or turn off an
              environment server below.
            </p>
          ) : null}
          <h3 className="px-3 pt-2 text-xs font-medium text-muted-foreground sm:px-4">
            From {environmentLabel}
          </h3>
          <SettingsGroup>
            <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">t3-code</p>
                <p className="text-xs text-muted-foreground">T3 Code tools · auto-approved</p>
              </div>
              <Badge variant="secondary">Built in</Badge>
            </div>
            {rows.inherited.map((row) => (
              <InheritedMcpServerRow
                key={row.name}
                row={row}
                existingNames={allNames}
                providers={providers}
                check={selectProjectMcpCheck(serverConfig, projectId, row.name, "global")}
                environmentLabel={environmentLabel}
                readOnly={!canManage}
                signIn={{ environmentId, target: { scope: "global", name: row.name }, canManage }}
                onTurnOff={(off) => saveProject(row.name, off ? { enabled: false } : null)}
                onOverride={(config) => saveProject(row.name, config)}
              />
            ))}
          </SettingsGroup>
          <p className="px-3 text-xs text-muted-foreground sm:px-4">{APPROVAL_NOTE}</p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {projectScoped ? (
        <Alert variant="info">
          <AlertDescription>
            MCP servers are set per environment. These apply to every project on {environmentLabel}.
          </AlertDescription>
        </Alert>
      ) : null}
      {noticeVisible ? (
        <Alert variant="success">
          <AlertDescription>{saveNotice(providers)}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="ghost" onClick={() => setNoticeVisible(false)}>
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <SettingsSection
        {...searchableSetting("mcp-servers")}
        headerAction={
          canManage ? (
            <Button size="xs" variant="outline" disabled={adding} onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden />
              Add server
            </Button>
          ) : null
        }
      >
        <SettingsGroup>
          <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">t3-code</p>
              <p className="text-xs text-muted-foreground">T3 Code tools · auto-approved</p>
              <ClaudeLiveStatus row={claude.view?.builtIn} />
            </div>
            <Badge variant="secondary">Built in</Badge>
          </div>
          {adding ? (
            <div className="px-3 py-3 sm:px-4">
              <McpServerForm
                isNew
                initial={emptyDraft()}
                existingNames={names}
                providers={providers}
                onCancel={() => setAdding(false)}
                onSave={async (draft) => {
                  const saved = await save(draft.name, configFromDraft(draft));
                  if (saved) setAdding(false);
                }}
              />
            </div>
          ) : null}
          {names.map((name) => {
            const config = servers[name]!;
            return (
              <McpServerRow
                key={name}
                name={name}
                config={config}
                existingNames={names}
                providers={providers}
                check={selectMcpServerCheck(serverConfig, "global", name)}
                claude={claude.view?.merged.get(name)}
                environmentLabel={environmentLabel}
                canCheck={canCheck}
                signIn={{ environmentId, target: { scope: "global", name }, canManage }}
                onCheck={() =>
                  void checkServers({
                    environmentId,
                    input: { targets: [{ scope: "global", name }] },
                  })
                }
                readOnly={!canManage}
                onSave={(next) => save(name, next)}
                onRemove={() => save(name, null)}
              />
            );
          })}
        </SettingsGroup>
        {names.length === 0 && !adding ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            No servers added. Added servers go to every provider session on {environmentLabel}.
          </p>
        ) : null}
        <p className="px-3 text-xs text-muted-foreground sm:px-4">{APPROVAL_NOTE}</p>
      </SettingsSection>
      <ClaudeMcpSection
        environmentId={environmentId}
        cwd={serverConfig?.cwd ?? null}
        providers={providers}
        t3Names={names}
      />
    </SettingsPageContainer>
  );
}

function McpServerRow({
  name,
  config,
  existingNames,
  providers,
  check,
  environmentLabel,
  canCheck,
  onCheck,
  readOnly,
  onSave,
  onRemove,
  badge,
  onUseEnvironmentConfig,
  signIn,
  claude,
}: {
  /** Claude's own report of this server, where the page has one. */
  readonly claude?: ClaudeMcpRow | undefined;
  readonly signIn: McpSignInProps;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly badge?: ReactNode;
  /** Present on a project override: drops it so the environment config applies again. */
  readonly onUseEnvironmentConfig?: (() => Promise<boolean>) | undefined;
  readonly existingNames: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly check: McpServerCheck | undefined;
  readonly environmentLabel: string;
  readonly canCheck: boolean;
  readonly onCheck: () => void;
  readonly readOnly: boolean;
  readonly onSave: (config: McpServerConfig) => Promise<boolean>;
  readonly onRemove?: (() => Promise<boolean>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const enabled = config.enabled !== false;

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="truncate">{name}</span>
            {badge}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {config.transport === "http" ? config.url : [config.command, ...config.args].join(" ")}
          </p>
          {enabled ? (
            <p className="truncate text-xs text-muted-foreground">
              {describeMcpServerCheck(check)}
              {check === undefined ? null : ` · checked on ${environmentLabel}`}
            </p>
          ) : null}
          {enabled ? <ClaudeLiveStatus row={claude} /> : null}
          {enabled ? <McpSignInControls {...signIn} config={config} check={check} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {enabled && canCheck ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={check?.status === "checking"}
              onClick={onCheck}
            >
              Re-check
            </Button>
          ) : null}
          {!readOnly && onUseEnvironmentConfig ? (
            <Button size="xs" variant="ghost" onClick={() => void onUseEnvironmentConfig()}>
              Use environment config
            </Button>
          ) : null}
          {!readOnly ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={editing}
              onClick={() => setEditing((open) => !open)}
            >
              {editing ? "Close" : "Edit"}
            </Button>
          ) : null}
          <Switch
            aria-label={`${name} enabled`}
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(next) => void onSave({ ...config, enabled: next })}
          />
        </div>
      </div>
      {editing && !readOnly ? (
        <div className="pt-3">
          <McpServerForm
            isNew={false}
            initial={draftFromConfig(name, config)}
            existingNames={existingNames}
            providers={providers}
            onCancel={() => setEditing(false)}
            onSave={async (draft) => {
              if (await onSave(configFromDraft(draft))) setEditing(false);
            }}
            {...(onRemove ? { onRemove: () => setRemoving(true) } : {})}
          />
        </div>
      ) : null}
      <AlertDialog open={removing && onRemove !== undefined} onOpenChange={setRemoving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              New sessions stop getting this server, and its stored secrets are deleted from this
              environment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                void onRemove?.();
              }}
            >
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

interface McpSignInProps {
  readonly environmentId: EnvironmentId;
  /** The sign-in this row uses: the environment's for an inherited server. */
  readonly target: { readonly scope: string; readonly name: string };
  readonly canManage: boolean;
}

/**
 * Sign in, sign out and the paste field for an OAuth server. The browser
 * redirect lands on the environment host; a remote client finishes by pasting
 * the final localhost URL here.
 */
function McpSignInControls({
  environmentId,
  target,
  canManage,
  config,
  check,
}: McpSignInProps & {
  readonly config: McpServerConfig;
  readonly check: McpServerCheck | undefined;
}) {
  const startSignIn = useAtomCommand(serverEnvironment.startMcpServerSignIn, {
    label: "start MCP sign-in",
  });
  const completeSignIn = useAtomCommand(serverEnvironment.completeMcpServerSignIn, {
    label: "complete MCP sign-in",
  });
  const signOut = useAtomCommand(serverEnvironment.signOutMcpServer, { label: "MCP sign-out" });
  const [pending, setPending] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [notice, setNotice] = useState<string>();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const remote = httpBaseUrl !== null && !isLoopbackHost(new URL(httpBaseUrl).hostname);
  // The redirect this computer is waiting for, so leaving the page frees its port.
  const receiving = useRef<string | null>(null);
  useEffect(
    () => () => {
      const url = receiving.current;
      if (url) void window.desktopBridge?.cancelMcpSignInCallback?.(url).catch(() => undefined);
    },
    [],
  );
  const control = mcpSignInControl(config, check);
  if (control.kind === "none") return null;
  if (control.kind === "blocked") {
    return <p className="text-xs text-muted-foreground">{control.message}</p>;
  }
  const signedIn = control.kind === "signed-in";
  if (!canManage && !signedIn) return null;
  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-center gap-2">
        {signedIn ? <span className="text-xs text-muted-foreground">Signed in</span> : null}
        {canManage ? (
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              if (signedIn) {
                setPending(false);
                await signOut({ environmentId, input: target });
                return;
              }
              const result = await startSignIn({ environmentId, input: target });
              if (result._tag !== "Success") return;
              const { authorizationUrl } = result.value;
              setNotice(undefined);
              if (!remote) {
                setPending(true);
                await ensureLocalApi().shell.openExternal(authorizationUrl);
                return;
              }
              // A remote host cannot see this computer's loopback, so desktop catches the redirect.
              const receive = window.desktopBridge?.receiveMcpSignInCallback;
              receiving.current = authorizationUrl;
              if (!receive) setPending(true);
              const outcome = await relayMcpSignIn({
                authorizationUrl,
                receive,
                openExternal: (url) => ensureLocalApi().shell.openExternal(url),
                complete: async (callback) =>
                  (
                    await completeSignIn({
                      environmentId,
                      input: { ...target, callbackUrl: callback },
                    })
                  )._tag === "Success",
              });
              receiving.current = null;
              if (outcome.kind === "paste") {
                setNotice(outcome.notice);
                setPending(true);
              } else {
                setPending(false);
              }
            }}
          >
            {signedIn ? "Sign out" : control.label}
          </Button>
        ) : null}
      </div>
      {pending && !signedIn ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void completeSignIn({
              environmentId,
              input: { ...target, callbackUrl: callbackUrl.trim() },
            }).then((result) => {
              if (result._tag === "Success") {
                setPending(false);
                setCallbackUrl("");
              }
            });
          }}
        >
          <Input
            aria-label="Sign-in redirect URL"
            font="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the final http://127.0.0.1... address if this page did not finish"
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <Button type="submit" size="xs" disabled={callbackUrl.trim().length === 0}>
            Finish
          </Button>
        </form>
      ) : null}
      {notice && pending && !signedIn ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  );
}

/** An environment server as a project sees it: switch it off for the project, or override it. */
function InheritedMcpServerRow({
  row,
  existingNames,
  providers,
  check,
  environmentLabel,
  readOnly,
  onTurnOff,
  onOverride,
  signIn,
}: {
  readonly signIn: McpSignInProps;
  readonly row: InheritedMcpRow;
  readonly existingNames: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly check: McpServerCheck | undefined;
  readonly environmentLabel: string;
  readonly readOnly: boolean;
  readonly onTurnOff: (off: boolean) => Promise<boolean>;
  readonly onOverride: (config: McpServerConfig) => Promise<boolean>;
}) {
  const [overriding, setOverriding] = useState(false);
  const { name, config } = row;
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {config.transport === "http" ? config.url : [config.command, ...config.args].join(" ")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.offOnEnvironment
              ? "Off on environment"
              : `${describeMcpServerCheck(check)}${check === undefined ? "" : ` · checked on ${environmentLabel}`}`}
          </p>
          {row.offOnEnvironment ? null : (
            <McpSignInControls {...signIn} config={config} check={check} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!readOnly && !row.offOnEnvironment ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={overriding}
              onClick={() => setOverriding((open) => !open)}
            >
              {overriding ? "Close" : "Override for project"}
            </Button>
          ) : null}
          <Switch
            aria-label={`${name} enabled for this project`}
            checked={!row.offOnEnvironment && !row.offForProject}
            disabled={readOnly || row.offOnEnvironment}
            onCheckedChange={(next) => void onTurnOff(!next)}
          />
        </div>
      </div>
      {overriding && !readOnly ? (
        <div className="pt-3">
          <McpServerForm
            isNew={false}
            initial={overrideDraftFromEnvironment(name, config)}
            existingNames={existingNames}
            providers={providers}
            note="Secrets stored for the environment are not copied. Enter any this project needs again."
            onCancel={() => setOverriding(false)}
            onSave={async (draft) => {
              if (await onOverride(configFromDraft(draft))) setOverriding(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** In-place editor. The name is only editable until the server is first saved. */
function McpServerForm({
  isNew,
  initial,
  existingNames,
  providers,
  note,
  onCancel,
  onSave,
  onRemove,
}: {
  readonly note?: string;
  readonly isNew: boolean;
  readonly initial: McpServerDraft;
  readonly existingNames: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onCancel: () => void;
  readonly onSave: (draft: McpServerDraft) => Promise<void>;
  readonly onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const errors = validateDraft(draft, { existingNames, isNew });
  const hasErrors = Object.keys(errors).length > 0;
  const unsupported = providersWithoutMcpSupport(providers, draft.transport);
  const queryTokenWarning =
    draft.transport === "http" ? urlQueryTokenWarning(draft.url) : undefined;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (hasErrors || saving) return;
        setSaving(true);
        void onSave(draft).finally(() => setSaving(false));
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-foreground">Name</span>
        <Input
          aria-label="Server name"
          aria-invalid={touched && errors.name !== undefined}
          autoCapitalize="none"
          spellCheck={false}
          disabled={!isNew}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        {touched && errors.name ? <FieldError>{errors.name}</FieldError> : null}
      </label>
      {isNew ? (
        <ToggleGroup
          aria-label="Transport"
          variant="segmented"
          value={[draft.transport]}
          onValueChange={(next) => {
            const transport = next[0];
            if (transport === "stdio" || transport === "http") setDraft({ ...draft, transport });
          }}
        >
          <Toggle value="stdio">Command</Toggle>
          <Toggle value="http">HTTP</Toggle>
        </ToggleGroup>
      ) : null}
      {draft.transport === "http" ? (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">URL</span>
            <Input
              aria-label="URL"
              aria-invalid={touched && errors.url !== undefined}
              font="mono"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
            {touched && errors.url ? <FieldError>{errors.url}</FieldError> : null}
            {queryTokenWarning ? (
              <p role="status" className="text-xs text-warning-foreground">
                {queryTokenWarning}
              </p>
            ) : null}
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">
                OAuth client ID (optional)
              </span>
              <Input
                aria-label="OAuth client ID"
                aria-invalid={touched && errors.oauthClientId !== undefined}
                font="mono"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Registered automatically"
                value={draft.oauthClientId}
                onChange={(event) => setDraft({ ...draft, oauthClientId: event.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">OAuth client secret</span>
              <Input
                aria-label="OAuth client secret"
                font="mono"
                autoComplete="off"
                spellCheck={false}
                type="password"
                placeholder={draft.oauthClientSecretRedacted ? "Stored securely" : "Optional"}
                value={draft.oauthClientSecret}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    oauthClientSecret: event.target.value,
                    oauthClientSecretRedacted: false,
                  })
                }
              />
            </label>
          </div>
          {touched && errors.oauthClientId ? <FieldError>{errors.oauthClientId}</FieldError> : null}
          <SecretRows
            title="Headers"
            addLabel="Add header"
            noun="header"
            namePlaceholder="Authorization"
            rows={draft.headers}
            error={touched ? errors.headers : undefined}
            onChange={(headers) => setDraft((current) => ({ ...current, headers }))}
          />
        </>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Command</span>
            <Input
              aria-label="Command"
              aria-invalid={touched && errors.command !== undefined}
              font="mono"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="npx"
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            />
            {touched && errors.command ? <FieldError>{errors.command}</FieldError> : null}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Arguments, one per line</span>
            <Textarea
              aria-label="Arguments"
              spellCheck={false}
              placeholder={"-y\n@modelcontextprotocol/server-github"}
              value={draft.args}
              onChange={(event) => setDraft({ ...draft, args: event.target.value })}
            />
          </label>
          <SecretRows
            title="Environment variables"
            addLabel="Add variable"
            noun="variable"
            namePlaceholder="NAME"
            rows={draft.env}
            error={touched ? errors.env : undefined}
            onChange={(env) => setDraft((current) => ({ ...current, env }))}
          />
        </>
      )}
      {unsupported.length > 0 ? (
        <p className="text-xs text-muted-foreground">Not available in {unsupported.join(", ")}.</p>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <p className="text-xs text-muted-foreground">{APPROVAL_NOTE}</p>
      <div className="flex items-center justify-between gap-2">
        <div>
          {onRemove ? (
            <Button type="button" size="xs" variant="destructive-outline" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="xs" disabled={saving || (touched && hasErrors)}>
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Name/value rows where a value can be marked sensitive: env variables and HTTP headers. */
function SecretRows({
  title,
  addLabel,
  noun,
  namePlaceholder,
  rows,
  error,
  onChange,
}: {
  readonly title: string;
  readonly addLabel: string;
  readonly noun: string;
  readonly namePlaceholder: string;
  readonly rows: ReadonlyArray<McpEnvDraftRow>;
  readonly error: string | undefined;
  readonly onChange: (rows: ReadonlyArray<McpEnvDraftRow>) => void;
}) {
  const setRow = (index: number, row: McpEnvDraftRow) =>
    onChange(rows.map((existing, at) => (at === index ? row : existing)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange([...rows, { name: "", value: "", sensitive: false, redacted: false }])
          }
        >
          <PlusIcon aria-hidden />
          {addLabel}
        </Button>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`${noun} name`}
            font="mono"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={namePlaceholder}
            value={row.name}
            onChange={(event) => setRow(index, { ...row, name: event.target.value })}
          />
          <Input
            aria-label={`${noun} value`}
            font="mono"
            autoComplete="off"
            spellCheck={false}
            type={row.sensitive ? "password" : "text"}
            placeholder={row.redacted ? "Stored securely" : "value"}
            value={row.value}
            onChange={(event) =>
              setRow(index, { ...row, value: event.target.value, redacted: false })
            }
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={row.sensitive ? "Sensitive: stored securely" : "Mark as sensitive"}
            aria-pressed={row.sensitive}
            // A stored secret stays sensitive until it is replaced.
            disabled={row.redacted}
            onClick={() => setRow(index, { ...row, sensitive: !row.sensitive })}
          >
            {row.sensitive ? <LockIcon aria-hidden /> : <LockOpenIcon aria-hidden />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${noun}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function FieldError({ children }: { readonly children: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}
