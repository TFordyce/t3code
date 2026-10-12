/**
 * Settings → MCP servers. Lists the user MCP servers an environment hands to
 * every provider session, beside the built-in `t3-code` one, and edits them in
 * place. Secret env values are stored on the host; this page only ever sees a
 * "stored securely" marker for them.
 *
 * @module McpServersSettings
 */
import type {
  EnvironmentId,
  McpServerConfig,
  ServerProvider,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
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
import {
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  providersWithoutMcpSupport,
  validateDraft,
  type McpEnvDraftRow,
  type McpServerDraft,
} from "./McpServersSettings.logic";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const APPROVAL_NOTE = "Tool calls go through each provider's normal approval.";

export function McpServersSettingsPanel() {
  const { environment, scope } = useSettingsScope();
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
    />
  );
}

function McpServersEnvironmentPanel({
  environmentId,
  environmentLabel,
  projectScoped,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectScoped: boolean;
}) {
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.mcpServers);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canManage = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, { patch: { mcpServers: {} } }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update MCP servers",
  });
  const [adding, setAdding] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const names = Object.keys(servers).toSorted();

  /** Resolves true when the server accepted the change. */
  const save = async (name: string, config: McpServerConfig | null) => {
    const patch: ServerSettingsPatch = { mcpServers: { [name]: config } };
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag !== "Success") return false;
    setNoticeVisible(true);
    return true;
  };

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
          <AlertDescription>Applies to new sessions.</AlertDescription>
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
    </SettingsPageContainer>
  );
}

function McpServerRow({
  name,
  config,
  existingNames,
  providers,
  readOnly,
  onSave,
  onRemove,
}: {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly existingNames: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly onSave: (config: McpServerConfig) => Promise<boolean>;
  readonly onRemove: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const enabled = config.enabled !== false;

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {[config.command, ...config.args].join(" ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
            onRemove={() => setRemoving(true)}
          />
        </div>
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
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
                void onRemove();
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

/** In-place editor. The name is only editable until the server is first saved. */
function McpServerForm({
  isNew,
  initial,
  existingNames,
  providers,
  onCancel,
  onSave,
  onRemove,
}: {
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
  const unsupported = providersWithoutMcpSupport(providers, "stdio");
  const setEnvRow = (index: number, row: McpEnvDraftRow) =>
    setDraft((current) => ({
      ...current,
      env: current.env.map((existing, at) => (at === index ? row : existing)),
    }));

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
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Environment variables</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              setDraft({
                ...draft,
                env: [...draft.env, { name: "", value: "", sensitive: false, redacted: false }],
              })
            }
          >
            <PlusIcon aria-hidden />
            Add variable
          </Button>
        </div>
        {draft.env.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label="Variable name"
              font="mono"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="NAME"
              value={row.name}
              onChange={(event) => setEnvRow(index, { ...row, name: event.target.value })}
            />
            <Input
              aria-label="Variable value"
              font="mono"
              autoComplete="off"
              spellCheck={false}
              type={row.sensitive ? "password" : "text"}
              placeholder={row.redacted ? "Stored securely" : "value"}
              value={row.value}
              onChange={(event) =>
                setEnvRow(index, { ...row, value: event.target.value, redacted: false })
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
              onClick={() => setEnvRow(index, { ...row, sensitive: !row.sensitive })}
            >
              {row.sensitive ? <LockIcon aria-hidden /> : <LockOpenIcon aria-hidden />}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Remove variable"
              onClick={() => setDraft({ ...draft, env: draft.env.filter((_, at) => at !== index) })}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        ))}
        {touched && errors.env ? <FieldError>{errors.env}</FieldError> : null}
      </div>
      {unsupported.length > 0 ? (
        <p className="text-xs text-muted-foreground">Not available in {unsupported.join(", ")}.</p>
      ) : null}
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

function FieldError({ children }: { readonly children: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}
