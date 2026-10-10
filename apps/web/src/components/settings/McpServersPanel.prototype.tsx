/**
 * PROTOTYPE — throwaway. Lives on branch `prototype/mcp-servers-panel` only.
 *
 * Question (wayfinder map "MCP servers panel", ticket "What should the MCP
 * servers panel look like?"): three structurally different MCP servers
 * panels on a new `/settings/mcp-servers` page, switchable via `?variant=`.
 * `?surface=` flips between the Settings panel, where a thread shows its
 * session MCP status, and the mobile read-only view. All data is in-memory
 * mock state; nothing touches the server.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GlobeIcon,
  LockIcon,
  LockOpenIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { SettingsSection } from "./settingsLayout";

// ---------------------------------------------------------------------------
// Mock model (mirrors the decided contracts shape, loosely)
// ---------------------------------------------------------------------------

type KeyValue = { name: string; value: string; sensitive: boolean; valueRedacted?: boolean };
type StdioConfig = {
  transport: "stdio";
  command: string;
  args: string[];
  env: KeyValue[];
  enabled: boolean;
};
type HttpConfig = { transport: "http"; url: string; headers: KeyValue[]; enabled: boolean };
type ServerConfig = StdioConfig | HttpConfig;
type ProjectEntry = ServerConfig | { enabled: false; disabledMarker: true };
type CheckStatus = "checking" | "connected" | "needs-auth" | "failed";
type Check = { status: CheckStatus; checkedAt: number; toolCount?: number; error?: string };
type Scope = "global" | "project";

const PROVIDERS = [
  "Codex",
  "Claude",
  "Cursor",
  "OpenCode",
  "Pi",
  "ACP",
  "Grok",
  "Antigravity",
] as const;
type Provider = (typeof PROVIDERS)[number];

/** Capability-derived support: Grok/Antigravity skip user servers in v1; ACP can't carry HTTP. */
function supports(provider: Provider, transport: ServerConfig["transport"]) {
  if (provider === "Grok" || provider === "Antigravity") return false;
  if (provider === "ACP" && transport === "http") return false;
  return true;
}
function supportNote(transport: ServerConfig["transport"]) {
  const missing = PROVIDERS.filter((provider) => !supports(provider, transport));
  return missing.length === 0 ? null : `Not available in ${missing.join(", ")}`;
}

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

const INITIAL_GLOBAL: Record<string, ServerConfig> = {
  github: {
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
    enabled: true,
  },
  linear: { transport: "http", url: "https://mcp.linear.app/mcp", headers: [], enabled: true },
  playwright: {
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    env: [],
    enabled: true,
  },
  postgres: {
    transport: "stdio",
    command: "uvx",
    args: ["postgres-mcp", "--access-mode=restricted"],
    env: [{ name: "DATABASE_URI", value: "", sensitive: true, valueRedacted: true }],
    enabled: true,
  },
  context7: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: [],
    enabled: true,
  },
  sentry: { transport: "http", url: "https://mcp.sentry.dev/mcp", headers: [], enabled: false },
};

const INITIAL_PROJECT: Record<string, ProjectEntry> = {
  postgres: {
    transport: "stdio",
    command: "uvx",
    args: ["postgres-mcp", "--access-mode=unrestricted"],
    env: [{ name: "DATABASE_URI", value: "", sensitive: true, valueRedacted: true }],
    enabled: true,
  },
  playwright: { enabled: false, disabledMarker: true },
  figma: { transport: "http", url: "http://127.0.0.1:3845/mcp", headers: [], enabled: true },
};

const INITIAL_CHECKS: Record<string, Check> = {
  "global:github": { status: "connected", checkedAt: minutesAgo(3), toolCount: 41 },
  "global:linear": {
    status: "needs-auth",
    checkedAt: minutesAgo(3),
    error: "401 Unauthorized (WWW-Authenticate: Bearer)",
  },
  "global:playwright": { status: "connected", checkedAt: minutesAgo(12), toolCount: 21 },
  "global:postgres": {
    status: "failed",
    checkedAt: minutesAgo(12),
    error: "connection refused (127.0.0.1:5432)",
  },
  "global:context7": { status: "checking", checkedAt: Date.now() },
  "project:postgres": { status: "connected", checkedAt: minutesAgo(1), toolCount: 8 },
  "project:figma": { status: "connected", checkedAt: minutesAgo(1), toolCount: 12 },
};

type Source = "built-in" | "global" | "global-off" | "overridden" | "off-here" | "project";
type EffectiveServer = {
  name: string;
  source: Source;
  config: ServerConfig;
  /** The environment's entry when a project replaces or switches it off. */
  globalConfig?: ServerConfig;
  check: Check | undefined;
  checkScope: Scope;
};

const SOURCE_LABEL: Record<Source, string> = {
  "built-in": "Built in",
  global: "From environment",
  "global-off": "Off on environment",
  overridden: "Replaced in this project",
  "off-here": "Off in this project",
  project: "This project only",
};

function effectiveServers(
  global: Record<string, ServerConfig>,
  project: Record<string, ProjectEntry> | null,
  checks: Record<string, Check>,
): EffectiveServer[] {
  const out: EffectiveServer[] = [];
  for (const [name, config] of Object.entries(global)) {
    const entry = project?.[name];
    if (entry && "disabledMarker" in entry) {
      out.push({
        name,
        source: "off-here",
        config,
        globalConfig: config,
        check: checks[`global:${name}`],
        checkScope: "global",
      });
    } else if (entry) {
      out.push({
        name,
        source: "overridden",
        config: entry,
        globalConfig: config,
        check: checks[`project:${name}`],
        checkScope: "project",
      });
    } else {
      out.push({
        name,
        source: config.enabled ? "global" : "global-off",
        config,
        check: config.enabled ? checks[`global:${name}`] : undefined,
        checkScope: "global",
      });
    }
  }
  for (const [name, entry] of Object.entries(project ?? {})) {
    if (name in global || "disabledMarker" in entry) continue;
    out.push({
      name,
      source: "project",
      config: entry,
      check: checks[`project:${name}`],
      checkScope: "project",
    });
  }
  return out;
}

const isActive = (server: EffectiveServer) =>
  server.source === "global" || server.source === "overridden" || server.source === "project";

function useMcpPrototypeState() {
  const [global, setGlobal] = useState(INITIAL_GLOBAL);
  const [project, setProject] = useState(INITIAL_PROJECT);
  const [checks, setChecks] = useState(INITIAL_CHECKS);
  const [notice, setNotice] = useState<string | null>(null);

  const recheck = (scope: Scope, name: string) => {
    const key = `${scope}:${name}`;
    setChecks((prev) => ({ ...prev, [key]: { status: "checking", checkedAt: Date.now() } }));
    setTimeout(() => {
      setChecks((prev) => ({
        ...prev,
        [key]: {
          status: "connected",
          checkedAt: Date.now(),
          toolCount: 5 + (name.length % 9),
        },
      }));
    }, 1400);
  };
  const saved = (scope: Scope, name: string) => {
    setNotice(
      `Saved “${name}”. Applies to new sessions. OpenCode sessions${
        scope === "project" ? " in this project" : ""
      } pick it up now.`,
    );
    recheck(scope, name);
  };
  return {
    global,
    project,
    checks,
    notice,
    dismissNotice: () => setNotice(null),
    recheck,
    saveGlobal: (name: string, config: ServerConfig) => {
      setGlobal((prev) => ({ ...prev, [name]: config }));
      saved("global", name);
    },
    removeGlobal: (name: string) =>
      setGlobal((prev) => Object.fromEntries(Object.entries(prev).filter(([n]) => n !== name))),
    setGlobalEnabled: (name: string, enabled: boolean) =>
      setGlobal((prev) => ({ ...prev, [name]: { ...prev[name]!, enabled } })),
    saveProject: (name: string, config: ServerConfig) => {
      setProject((prev) => ({ ...prev, [name]: config }));
      saved("project", name);
    },
    disableInProject: (name: string) =>
      setProject((prev) => ({ ...prev, [name]: { enabled: false, disabledMarker: true } })),
    resetInProject: (name: string) =>
      setProject((prev) => Object.fromEntries(Object.entries(prev).filter(([n]) => n !== name))),
  };
}
type McpState = ReturnType<typeof useMcpPrototypeState>;

export interface McpPrototypeProps {
  state: McpState;
  isProject: boolean;
  scopeLabel: string;
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Small shared bits (status presentation + the stdio/HTTP form)
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<CheckStatus | "unchecked" | "off", string> = {
  connected: "bg-success",
  "needs-auth": "bg-warning",
  failed: "bg-destructive",
  checking: "bg-muted-foreground/50 ring-2 ring-muted-foreground/20",
  unchecked: "border border-muted-foreground/50",
  off: "border border-dashed border-muted-foreground/40",
};

function StatusDot({ server }: { server: EffectiveServer }) {
  const key = !isActive(server) ? "off" : (server.check?.status ?? "unchecked");
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT[key])} />;
}

function relative(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}

function statusText(server: EffectiveServer) {
  if (server.source === "built-in") return "Always on";
  if (!isActive(server)) return SOURCE_LABEL[server.source];
  const check = server.check;
  if (!check) return "Not checked yet";
  switch (check.status) {
    case "checking":
      return "Checking…";
    case "connected":
      return `Connected · ${check.toolCount} tools`;
    case "needs-auth":
      return "Needs sign-in";
    case "failed":
      return `Failed · ${check.error}`;
  }
}

function StatusBadge({ server }: { server: EffectiveServer }) {
  if (!isActive(server)) return <Badge variant="outline">{SOURCE_LABEL[server.source]}</Badge>;
  const status = server.check?.status;
  const variant =
    status === "connected"
      ? "success"
      : status === "needs-auth"
        ? "warning"
        : status === "failed"
          ? "error"
          : "outline";
  return (
    <Badge variant={variant}>
      {status === "connected"
        ? `Connected · ${server.check?.toolCount} tools`
        : status === "needs-auth"
          ? "Needs sign-in"
          : status === "failed"
            ? "Failed"
            : status === "checking"
              ? "Checking…"
              : "Not checked"}
    </Badge>
  );
}

function TransportIcon({ transport }: { transport: ServerConfig["transport"] }) {
  return transport === "stdio" ? (
    <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

function configSummary(config: ServerConfig) {
  return config.transport === "stdio" ? [config.command, ...config.args].join(" ") : config.url;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function nameError(name: string, taken: readonly string[]) {
  if (name.length === 0) return "Required";
  if (!NAME_PATTERN.test(name)) return "Lowercase letters, digits, - and _ (max 32)";
  if (name.startsWith("t3-code")) return "Names starting with t3-code are reserved";
  if (taken.includes(name)) return "A server with this name already exists";
  return null;
}

function KeyValueRows({
  label,
  rows,
  onChange,
  namePlaceholder,
  readOnly,
}: {
  label: string;
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  namePlaceholder: string;
  readOnly?: boolean | undefined;
}) {
  const update = (index: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {readOnly ? null : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onChange([...rows, { name: "", value: "", sensitive: true }])}
          >
            <PlusIcon /> Add
          </Button>
        )}
      </div>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground/70">None</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            size="sm"
            className="w-40 font-mono"
            placeholder={namePlaceholder}
            value={row.name}
            disabled={readOnly}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <Input
            size="sm"
            className="min-w-0 flex-1 font-mono"
            type={row.sensitive ? "password" : "text"}
            placeholder={row.valueRedacted ? "•••••••• stored securely" : "value"}
            value={row.value}
            disabled={readOnly}
            onChange={(event) => update(index, { value: event.target.value, valueRedacted: false })}
          />
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={readOnly}
            aria-label={row.sensitive ? "Secret (stored in secret store)" : "Plain value"}
            title={
              row.sensitive ? "Secret: stored in the secret store" : "Plain: saved in settings"
            }
            onClick={() => update(index, { sensitive: !row.sensitive })}
          >
            {row.sensitive ? <LockIcon /> : <LockOpenIcon />}
          </Button>
          {readOnly ? null : (
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label="Remove"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ServerForm({
  initialName,
  initial,
  takenNames,
  onSave,
  onCancel,
  saveLabel = "Save",
  readOnly,
  compact,
}: {
  initialName?: string;
  initial?: ServerConfig;
  takenNames: readonly string[];
  onSave: (name: string, config: ServerConfig) => void;
  onCancel?: () => void;
  saveLabel?: string;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const editing = initialName !== undefined;
  const [name, setName] = useState(initialName ?? "");
  const [transport, setTransport] = useState<ServerConfig["transport"]>(
    initial?.transport ?? "stdio",
  );
  const [command, setCommand] = useState(initial?.transport === "stdio" ? initial.command : "");
  const [args, setArgs] = useState(initial?.transport === "stdio" ? initial.args.join(" ") : "");
  const [env, setEnv] = useState<KeyValue[]>(initial?.transport === "stdio" ? initial.env : []);
  const [url, setUrl] = useState(initial?.transport === "http" ? initial.url : "");
  const [headers, setHeaders] = useState<KeyValue[]>(
    initial?.transport === "http" ? initial.headers : [],
  );
  const [touched, setTouched] = useState(false);
  const error = editing ? null : nameError(name, takenNames);
  const queryToken = transport === "http" && /[?&](token|key|api_key)=/i.test(url);

  const submit = () => {
    setTouched(true);
    if (error) return;
    onSave(
      name,
      transport === "stdio"
        ? {
            transport,
            command,
            args: args.split(" ").filter(Boolean),
            env,
            enabled: initial?.enabled ?? true,
          }
        : { transport, url, headers, enabled: initial?.enabled ?? true },
    );
  };

  return (
    <div className={cn("space-y-3", compact ? "" : "rounded-lg border bg-muted/20 p-3")}>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <Input
            size="sm"
            className="font-mono"
            value={name}
            disabled={editing || readOnly}
            placeholder="e.g. github"
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          <span className="block text-[11px] text-muted-foreground/70">
            {editing ? (
              "Names can't be changed. Create a new server to rename."
            ) : touched && error ? (
              <span className="text-destructive-foreground">{error}</span>
            ) : (
              "Tools appear to agents as mcp__name__tool."
            )}
          </span>
        </label>
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Transport</span>
          <div className="flex gap-1">
            {(["stdio", "http"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={transport === option ? "secondary" : "ghost"}
                disabled={readOnly}
                onClick={() => setTransport(option)}
              >
                <TransportIcon transport={option} />
                {option === "stdio" ? "Command" : "HTTP"}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {transport === "stdio" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Command</span>
              <Input
                size="sm"
                className="font-mono"
                placeholder="npx"
                value={command}
                disabled={readOnly}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Arguments</span>
              <Input
                size="sm"
                className="font-mono"
                placeholder="-y @scope/server"
                value={args}
                disabled={readOnly}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            Runs on this environment's host, in each session's working directory.
          </p>
          <KeyValueRows
            label="Environment variables"
            rows={env}
            onChange={setEnv}
            namePlaceholder="NAME"
            readOnly={readOnly}
          />
        </>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">URL</span>
            <Input
              size="sm"
              className="font-mono"
              placeholder="https://example.com/mcp"
              value={url}
              disabled={readOnly}
              onChange={(event) => setUrl(event.target.value)}
            />
            {queryToken ? (
              <span className="block text-[11px] text-warning-foreground">
                URLs aren't stored as secrets. Put tokens in a header instead.
              </span>
            ) : null}
          </label>
          <KeyValueRows
            label="Headers"
            rows={headers}
            onChange={setHeaders}
            namePlaceholder="Authorization"
            readOnly={readOnly}
          />
        </>
      )}
      <p className="text-[11px] text-muted-foreground/70">
        {supportNote(transport) ?? "Available in every provider."} Tool calls go through each
        provider's normal approval.
      </p>
      {readOnly ? null : (
        <div className="flex justify-end gap-2">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" onClick={submit}>
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function SavedNotice({ state }: { state: McpState }) {
  if (!state.notice) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/8 px-3 py-2 text-xs text-info-foreground">
      <span className="flex-1">{state.notice}</span>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label="Dismiss"
        onClick={state.dismissNotice}
      >
        <XIcon />
      </Button>
    </div>
  );
}

const BUILT_IN: EffectiveServer = {
  name: "t3-code",
  source: "built-in",
  config: { transport: "http", url: "built in", headers: [], enabled: true },
  check: undefined,
  checkScope: "global",
};

function useServers({ state, isProject }: Pick<McpPrototypeProps, "state" | "isProject">) {
  return effectiveServers(state.global, isProject ? state.project : null, state.checks);
}

/** In a project every save lands in the project: new = project-only, inherited = override. */
function saveFor(props: McpPrototypeProps) {
  return props.isProject ? props.state.saveProject : props.state.saveGlobal;
}

// ---------------------------------------------------------------------------
// Session MCP status mock (the thread surface)
// ---------------------------------------------------------------------------

type SessionServer = {
  name: string;
  status: "connecting" | "connected" | "needs-auth" | "failed" | "disabled" | "unsupported";
  toolCount?: number;
  error?: string;
};
const SESSION_PROVIDERS = ["Claude", "Grok", "Cursor"] as const;
type SessionProvider = (typeof SESSION_PROVIDERS)[number];
const SESSION_STATUS: Record<SessionProvider, SessionServer[] | "unknown"> = {
  Claude: [
    { name: "github", status: "connected", toolCount: 41 },
    { name: "linear", status: "needs-auth" },
    { name: "postgres", status: "connected", toolCount: 8 },
    { name: "context7", status: "failed", error: "timed out after 30s" },
    { name: "figma", status: "connected", toolCount: 12 },
  ],
  Grok: [
    { name: "github", status: "unsupported" },
    { name: "linear", status: "unsupported" },
    { name: "postgres", status: "unsupported" },
    { name: "context7", status: "unsupported" },
    { name: "figma", status: "unsupported" },
  ],
  // Cursor reports nothing; the UI falls back to the server check.
  Cursor: "unknown",
};
const SESSION_DOT: Record<SessionServer["status"], string> = {
  connected: "bg-success",
  connecting: "bg-muted-foreground/50",
  "needs-auth": "bg-warning",
  failed: "bg-destructive",
  disabled: "border border-muted-foreground/50",
  unsupported: "border border-dashed border-muted-foreground/50",
};
const SESSION_TEXT: Record<SessionServer["status"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  disabled: "Disabled",
  unsupported: "Not available in this provider",
};

function SessionList({ provider }: { provider: SessionProvider }) {
  const list = SESSION_STATUS[provider];
  if (list === "unknown") {
    return (
      <div className="space-y-1.5 text-xs">
        <p className="text-muted-foreground">
          {provider} doesn't report MCP status. Showing T3's last server checks.
        </p>
        {["github", "linear", "postgres", "context7", "figma"].map((name) => (
          <div key={name} className="flex items-center gap-2">
            <span className="size-2 rounded-full border border-muted-foreground/50" />
            <span className="font-mono">{name}</span>
            <span className="ml-auto text-muted-foreground">Unknown · last check OK</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 text-xs">
      {list.map((server) => (
        <div key={server.name} className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", SESSION_DOT[server.status])} />
          <span className="font-mono">{server.name}</span>
          <span className="ml-auto text-right text-muted-foreground">
            {SESSION_TEXT[server.status]}
            {server.toolCount ? ` · ${server.toolCount} tools` : ""}
            {server.error ? ` · ${server.error}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function sessionSummary(provider: SessionProvider) {
  const list = SESSION_STATUS[provider];
  if (list === "unknown") return { label: "MCP", tone: "muted" as const };
  const connected = list.filter((s) => s.status === "connected").length;
  const problem = list.some((s) => s.status === "failed" || s.status === "needs-auth");
  return {
    label: `MCP ${connected}/${list.length}`,
    tone: problem ? ("warn" as const) : ("ok" as const),
  };
}

/** A fake thread chrome so each variant can place session status in context. */
function MockThread({
  provider,
  setProvider,
  rightPanel,
  timelineExtra,
  composerExtra,
}: {
  provider: SessionProvider;
  setProvider: (provider: SessionProvider) => void;
  rightPanel?: ReactNode;
  timelineExtra?: ReactNode;
  composerExtra?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        Mock thread provider:
        {SESSION_PROVIDERS.map((option) => (
          <Button
            key={option}
            size="xs"
            variant={provider === option ? "secondary" : "ghost"}
            onClick={() => setProvider(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      <div className="flex h-[30rem] overflow-hidden rounded-xl border">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b px-4 py-2 text-sm font-medium">Fix flaky checkout tests</div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            <div className="ml-auto w-fit max-w-sm rounded-xl bg-secondary px-3 py-2">
              Why does checkout.spec fail on CI only?
            </div>
            <p className="max-w-md text-muted-foreground">
              Looking at the failing runs with the GitHub tools, then querying the orders table…
            </p>
            {timelineExtra}
          </div>
          <div className="border-t p-3">
            <div className="rounded-xl border bg-background px-3 py-2 text-sm text-muted-foreground/60">
              Ask {provider} anything…
              <div className="mt-2 flex items-center gap-2">{composerExtra}</div>
            </div>
          </div>
        </div>
        {rightPanel}
      </div>
    </div>
  );
}

function MobileFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-[390px] overflow-hidden rounded-[2rem] border-4 border-zinc-800 bg-background">
      <div className="h-[44rem] overflow-y-auto">{children}</div>
    </div>
  );
}

function MobileNote() {
  return (
    <p className="px-4 pb-6 text-center text-[11px] text-muted-foreground">
      Edit and re-check MCP servers from T3 Code on desktop or the web.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Variant A — Rows with inline expand (closest to Providers/Device hosts)
// ---------------------------------------------------------------------------

function RowA({
  props,
  server,
  expanded,
  onToggle,
}: {
  props: McpPrototypeProps;
  server: EffectiveServer;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { state, isProject, readOnly } = props;
  const builtIn = server.source === "built-in";
  const note = builtIn ? null : supportNote(server.config.transport);
  const toggle = builtIn ? null : isProject ? (
    server.source === "project" ? null : (
      <Switch
        size="sm"
        checked={server.source !== "off-here"}
        disabled={readOnly || server.source === "global-off"}
        aria-label={`Use ${server.name} in this project`}
        onCheckedChange={(checked) =>
          checked ? state.resetInProject(server.name) : state.disableInProject(server.name)
        }
      />
    )
  ) : (
    <Switch
      size="sm"
      checked={server.config.enabled}
      disabled={readOnly}
      aria-label={`Enable ${server.name}`}
      onCheckedChange={(checked) => state.setGlobalEnabled(server.name, checked)}
    />
  );
  return (
    <div className="px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          disabled={builtIn}
          onClick={onToggle}
        >
          <StatusDot server={server} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm font-medium">{server.name}</span>
              <TransportIcon transport={server.config.transport} />
              {isProject && server.source === "overridden" ? (
                <Badge variant="info" size="sm">
                  Overridden
                </Badge>
              ) : null}
              {isProject && server.source === "project" ? (
                <Badge variant="secondary" size="sm">
                  Project
                </Badge>
              ) : null}
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground/70">
              {builtIn ? "T3 Code tools · auto-approved" : configSummary(server.config)}
            </p>
          </div>
          <div className="hidden shrink-0 text-right text-xs sm:block">
            <div
              className={cn(
                server.check?.status === "failed" &&
                  isActive(server) &&
                  "text-destructive-foreground",
                server.check?.status === "needs-auth" &&
                  isActive(server) &&
                  "text-warning-foreground",
                "max-w-64 truncate",
              )}
            >
              {statusText(server)}
            </div>
            {note && isActive(server) ? (
              <div className="text-[11px] text-muted-foreground/60">{note}</div>
            ) : null}
          </div>
          {builtIn ? (
            <LockIcon className="size-3.5 text-muted-foreground/60" />
          ) : expanded ? (
            <ChevronDownIcon className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          )}
        </button>
        {readOnly ? null : toggle}
      </div>
      {expanded && !builtIn ? (
        <div className="mt-3 space-y-2 pl-5">
          {server.check?.error && isActive(server) ? (
            <p className="text-xs text-destructive-foreground">{server.check.error}</p>
          ) : null}
          {isProject && server.globalConfig ? (
            <p className="text-xs text-muted-foreground">
              {server.source === "overridden"
                ? "This project uses its own config instead of the environment's."
                : "Saving creates a config for this project only."}
            </p>
          ) : null}
          <ServerForm
            initialName={server.name}
            initial={server.config}
            takenNames={[]}
            readOnly={readOnly}
            onSave={(name, config) => {
              saveFor(props)(name, config);
              onToggle();
            }}
            onCancel={onToggle}
            saveLabel={isProject && server.source === "global" ? "Override for project" : "Save"}
          />
          {readOnly ? null : (
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => state.recheck(server.checkScope, server.name)}
              >
                <RefreshCwIcon /> Re-check
              </Button>
              {isProject && server.source === "overridden" ? (
                <Button size="xs" variant="ghost" onClick={() => state.resetInProject(server.name)}>
                  Use environment config
                </Button>
              ) : null}
              {(!isProject && server.source !== "built-in") || server.source === "project" ? (
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() =>
                    server.source === "project"
                      ? state.resetInProject(server.name)
                      : state.removeGlobal(server.name)
                  }
                >
                  <Trash2Icon /> Remove
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function VariantA(props: McpPrototypeProps) {
  const servers = useServers(props);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const toggle = (name: string) => setExpanded((current) => (current === name ? null : name));
  const addButton = props.readOnly ? null : (
    <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
      <PlusIcon /> Add server
    </Button>
  );
  const addForm = adding ? (
    <div className="p-3">
      <ServerForm
        takenNames={servers.map((s) => s.name)}
        onSave={(name, config) => {
          saveFor(props)(name, config);
          setAdding(false);
        }}
        onCancel={() => setAdding(false)}
        saveLabel={props.isProject ? "Add to this project" : "Add server"}
      />
    </div>
  ) : null;

  if (!props.isProject) {
    return (
      <div className="space-y-4">
        <SavedNotice state={props.state} />
        <SettingsSection title="MCP servers" headerAction={addButton}>
          {addForm}
          <RowA props={props} server={BUILT_IN} expanded={false} onToggle={() => {}} />
          {servers.map((server) => (
            <RowA
              key={server.name}
              props={props}
              server={server}
              expanded={expanded === server.name}
              onToggle={() => toggle(server.name)}
            />
          ))}
        </SettingsSection>
      </div>
    );
  }
  const own = servers.filter((s) => s.source === "project" || s.source === "overridden");
  const inherited = servers.filter((s) => s.source !== "project" && s.source !== "overridden");
  return (
    <div className="space-y-4">
      <SavedNotice state={props.state} />
      <SettingsSection title="This project" headerAction={addButton}>
        {addForm}
        {own.length === 0 && !adding ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">No project servers.</p>
        ) : null}
        {own.map((server) => (
          <RowA
            key={server.name}
            props={props}
            server={server}
            expanded={expanded === server.name}
            onToggle={() => toggle(server.name)}
          />
        ))}
      </SettingsSection>
      <SettingsSection title={`From ${props.scopeLabel.split(" / ")[1] ?? "environment"}`}>
        <RowA props={props} server={BUILT_IN} expanded={false} onToggle={() => {}} />
        {inherited.map((server) => (
          <RowA
            key={server.name}
            props={props}
            server={server}
            expanded={expanded === server.name}
            onToggle={() => toggle(server.name)}
          />
        ))}
      </SettingsSection>
    </div>
  );
}

function ThreadA() {
  const [provider, setProvider] = useState<SessionProvider>("Claude");
  const [open, setOpen] = useState(false);
  const summary = sessionSummary(provider);
  return (
    <MockThread
      provider={provider}
      setProvider={setProvider}
      composerExtra={
        <div className="relative">
          <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)}>
            <span
              className={cn(
                "size-1.5 rounded-full",
                summary.tone === "ok" && "bg-success",
                summary.tone === "warn" && "bg-warning",
                summary.tone === "muted" && "border border-muted-foreground/60",
              )}
            />
            <PlugIcon /> {summary.label}
          </Button>
          {open ? (
            <div className="absolute bottom-8 left-0 z-10 w-80 space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
              <div className="text-xs font-medium">MCP servers in this session</div>
              <SessionList provider={provider} />
              <Button size="xs" variant="link">
                Manage MCP servers →
              </Button>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function MobileA(props: McpPrototypeProps) {
  const servers = useServers(props);
  return (
    <MobileFrame>
      <div className="px-4 pt-6 pb-2 text-lg font-semibold">MCP servers</div>
      <div className="divide-y">
        {[BUILT_IN, ...servers].map((server) => (
          <div key={server.name} className="flex items-center gap-3 px-4 py-3">
            <StatusDot server={server} />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm">{server.name}</div>
              <div className="truncate text-xs text-muted-foreground">{statusText(server)}</div>
            </div>
            {props.isProject && server.source !== "built-in" && server.source !== "global" ? (
              <Badge variant="outline" size="sm">
                {SOURCE_LABEL[server.source]}
              </Badge>
            ) : null}
          </div>
        ))}
      </div>
      <MobileNote />
    </MobileFrame>
  );
}

// ---------------------------------------------------------------------------
// Variant B — Master–detail with an explicit inheritance control
// ---------------------------------------------------------------------------

function DetailB({ props, server }: { props: McpPrototypeProps; server: EffectiveServer }) {
  const { state, isProject, readOnly } = props;
  if (server.source === "built-in") {
    return (
      <div className="space-y-2 text-sm">
        <div className="font-mono text-base font-medium">t3-code</div>
        <p className="text-muted-foreground">
          T3 Code's own tools (threads, previews, devices). Always on in every provider, and its
          tools are auto-approved. It can't be edited or turned off.
        </p>
      </div>
    );
  }
  const mode =
    server.source === "off-here" ? "off" : server.source === "overridden" ? "own" : "inherit";
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-base font-medium">{server.name}</span>
        <StatusBadge server={server} />
        <div className="flex-1" />
        {readOnly || !isActive(server) ? null : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => state.recheck(server.checkScope, server.name)}
          >
            <RefreshCwIcon /> Re-check
          </Button>
        )}
      </div>

      {isProject && server.globalConfig ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">In this project</div>
          <div className="flex gap-1">
            {(
              [
                ["inherit", "Use environment config"],
                ["own", "Use own config"],
                ["off", "Off"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={mode === key ? "secondary" : "ghost"}
                disabled={readOnly}
                onClick={() => {
                  if (key === "inherit") state.resetInProject(server.name);
                  if (key === "off") state.disableInProject(server.name);
                  if (key === "own") state.saveProject(server.name, server.globalConfig!);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border p-3 text-xs">
        <div className="mb-1 font-medium">Server check</div>
        {server.check ? (
          <div className="space-y-0.5 text-muted-foreground">
            <div>
              {statusText(server)} · checked {relative(server.check.checkedAt)} on this environment
            </div>
            {server.check.status === "needs-auth" ? (
              <div className="text-warning-foreground">
                The server asked for sign-in. Add an Authorization header.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-muted-foreground">
            {isActive(server) ? "Not checked yet." : "Not checked while off."}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {PROVIDERS.map((provider) => (
            <Badge
              key={provider}
              size="sm"
              variant={supports(provider, server.config.transport) ? "secondary" : "outline"}
              className={cn(
                !supports(provider, server.config.transport) && "line-through opacity-60",
              )}
            >
              {provider}
            </Badge>
          ))}
        </div>
      </div>

      {mode === "off" ? (
        <p className="text-xs text-muted-foreground">
          Off in this project. Other projects still use the environment's config.
        </p>
      ) : (
        <ServerForm
          key={`${server.name}:${server.source}`}
          initialName={server.name}
          initial={server.config}
          takenNames={[]}
          compact
          readOnly={readOnly || (isProject && mode === "inherit")}
          onSave={saveFor(props)}
        />
      )}
      {isProject && mode === "inherit" && !readOnly ? (
        <p className="text-xs text-muted-foreground">
          Choose “Use own config” to edit this server for this project only.
        </p>
      ) : null}
      {!readOnly && (!isProject || server.source === "project") ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          onClick={() =>
            server.source === "project"
              ? state.resetInProject(server.name)
              : state.removeGlobal(server.name)
          }
        >
          <Trash2Icon /> Remove server
        </Button>
      ) : null}
    </div>
  );
}

function VariantB(props: McpPrototypeProps) {
  const servers = useServers(props);
  const all = [BUILT_IN, ...servers];
  const [selected, setSelected] = useState<string | "new">(servers[0]?.name ?? "t3-code");
  const server = all.find((s) => s.name === selected);
  const groups: Array<[string, EffectiveServer[]]> = props.isProject
    ? [
        ["This project", servers.filter((s) => s.source === "project")],
        ["Environment", [BUILT_IN, ...servers.filter((s) => s.source !== "project")]],
      ]
    : [["Environment", all]];
  return (
    <div className="space-y-4">
      <SavedNotice state={props.state} />
      <div className="flex min-h-[32rem] overflow-hidden rounded-xl border">
        <div className="w-60 shrink-0 border-r bg-muted/20 p-2">
          {groups.map(([label, list]) => (
            <div key={label} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {label}
              </div>
              {list.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setSelected(s.name)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    selected === s.name ? "bg-accent" : "hover:bg-accent/50",
                    !isActive(s) && s.source !== "built-in" && "text-muted-foreground",
                  )}
                >
                  <StatusDot server={s} />
                  <span className="flex-1 truncate font-mono">{s.name}</span>
                  {s.source === "overridden" ? (
                    <span className="text-[10px] text-info-foreground">own</span>
                  ) : s.source === "off-here" || s.source === "global-off" ? (
                    <span className="text-[10px]">off</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
          {props.readOnly ? null : (
            <Button size="xs" variant="ghost" onClick={() => setSelected("new")}>
              <PlusIcon /> Add server
            </Button>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {selected === "new" ? (
            <div className="space-y-3">
              <div className="text-base font-medium">
                New server {props.isProject ? "for this project" : "on this environment"}
              </div>
              <ServerForm
                compact
                takenNames={all.map((s) => s.name)}
                onSave={(name, config) => {
                  saveFor(props)(name, config);
                  setSelected(name);
                }}
                saveLabel="Add server"
              />
            </div>
          ) : server ? (
            <DetailB props={props} server={server} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ThreadB() {
  const [provider, setProvider] = useState<SessionProvider>("Claude");
  return (
    <MockThread
      provider={provider}
      setProvider={setProvider}
      rightPanel={
        <div className="w-72 shrink-0 border-l">
          <div className="flex gap-1 border-b px-2 py-1.5 text-xs">
            <span className="rounded px-2 py-1 text-muted-foreground">Diff</span>
            <span className="rounded px-2 py-1 text-muted-foreground">Preview</span>
            <span className="rounded bg-accent px-2 py-1">MCP</span>
          </div>
          <div className="space-y-3 p-3">
            <div className="text-xs font-medium">This session</div>
            <SessionList provider={provider} />
            <p className="text-[11px] text-muted-foreground">
              Changes to MCP servers apply to new sessions.
            </p>
          </div>
        </div>
      }
    />
  );
}

function MobileB(props: McpPrototypeProps) {
  const servers = useServers(props);
  const [open, setOpen] = useState<EffectiveServer | null>(null);
  return (
    <MobileFrame>
      {open ? (
        <div className="space-y-4 p-4">
          <Button size="xs" variant="ghost" onClick={() => setOpen(null)}>
            ‹ MCP servers
          </Button>
          <DetailB props={{ ...props, readOnly: true }} server={open} />
        </div>
      ) : (
        <>
          <div className="px-4 pt-6 pb-2 text-lg font-semibold">MCP servers</div>
          {[BUILT_IN, ...servers].map((server) => (
            <button
              key={server.name}
              type="button"
              className="flex w-full items-center gap-3 border-b px-4 py-3 text-left"
              onClick={() => setOpen(server)}
            >
              <StatusDot server={server} />
              <span className="flex-1 font-mono text-sm">{server.name}</span>
              <ChevronRightIcon className="size-4 text-muted-foreground" />
            </button>
          ))}
          <MobileNote />
        </>
      )}
    </MobileFrame>
  );
}

// ---------------------------------------------------------------------------
// Variant C — Provider matrix table, edit in a side sheet
// ---------------------------------------------------------------------------

function VariantC(props: McpPrototypeProps) {
  const { state, isProject, readOnly } = props;
  const servers = useServers(props);
  const [editing, setEditing] = useState<EffectiveServer | "new" | null>(null);
  return (
    <div className="space-y-3">
      <SavedNotice state={state} />
      <div className="flex items-center gap-2">
        <h2 className="text-sm text-foreground/70">
          MCP servers{isProject ? ` · ${props.scopeLabel}` : ""}
        </h2>
        <div className="flex-1" />
        {readOnly ? null : (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                servers.filter(isActive).forEach((s) => state.recheck(s.checkScope, s.name))
              }
            >
              <RefreshCwIcon /> Re-check all
            </Button>
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> Add server
            </Button>
          </>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Server</TableHead>
              {isProject ? <TableHead>Source</TableHead> : null}
              <TableHead>Check</TableHead>
              {PROVIDERS.map((provider) => (
                <TableHead key={provider} className="text-center text-[11px]">
                  {provider}
                </TableHead>
              ))}
              <TableHead className="text-center">On</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[BUILT_IN, ...servers].map((server) => (
              <TableRow
                key={server.name}
                className={cn(server.source !== "built-in" && "cursor-pointer")}
                onClick={() => server.source !== "built-in" && setEditing(server)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <TransportIcon transport={server.config.transport} />
                    <span className="font-mono">{server.name}</span>
                  </div>
                </TableCell>
                {isProject ? (
                  <TableCell className="text-xs text-muted-foreground">
                    {SOURCE_LABEL[server.source]}
                  </TableCell>
                ) : null}
                <TableCell>
                  <div className="flex items-center gap-1.5 text-xs">
                    <StatusDot server={server} />
                    <span className="max-w-40 truncate">{statusText(server)}</span>
                  </div>
                </TableCell>
                {PROVIDERS.map((provider) => (
                  <TableCell key={provider} className="text-center text-xs">
                    {!isActive(server) && server.source !== "built-in" ? (
                      <span className="text-muted-foreground/40">·</span>
                    ) : server.source === "built-in" ||
                      supports(provider, server.config.transport) ? (
                      <span className="text-success-foreground">✓</span>
                    ) : (
                      <span className="text-muted-foreground/60" title="Not available">
                        —
                      </span>
                    )}
                  </TableCell>
                ))}
                <TableCell className="text-center" onClick={(event) => event.stopPropagation()}>
                  {server.source === "built-in" ? (
                    <LockIcon className="mx-auto size-3.5 text-muted-foreground/60" />
                  ) : server.source === "project" ? null : (
                    <Switch
                      size="sm"
                      disabled={readOnly || (isProject && server.source === "global-off")}
                      checked={
                        isProject
                          ? server.source !== "off-here" && server.source !== "global-off"
                          : server.config.enabled
                      }
                      aria-label={`Enable ${server.name}`}
                      onCheckedChange={(checked) =>
                        isProject
                          ? checked
                            ? state.resetInProject(server.name)
                            : state.disableInProject(server.name)
                          : state.setGlobalEnabled(server.name, checked)
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        ✓ the provider gets this server · — the provider can't carry this transport. Checks run on
        this environment's host.
      </p>
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetPopup side="right" className="w-[32rem] max-w-full">
          <SheetHeader>
            <SheetTitle>
              {editing === "new" ? "Add MCP server" : editing ? editing.name : ""}
            </SheetTitle>
            <SheetDescription>
              {editing === "new"
                ? isProject
                  ? "Only this project's sessions get it."
                  : "Every project on this environment gets it."
                : editing
                  ? `${SOURCE_LABEL[editing.source]} · ${statusText(editing)}`
                  : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 overflow-y-auto px-6 pb-6">
            {editing && editing !== "new" && isProject && editing.source === "global" ? (
              <p className="text-xs text-muted-foreground">
                Saving here creates a config for this project. The environment's stays as is.
              </p>
            ) : null}
            {editing ? (
              <ServerForm
                key={editing === "new" ? "new" : editing.name}
                compact
                {...(editing === "new"
                  ? {}
                  : { initialName: editing.name, initial: editing.config })}
                takenNames={servers.map((s) => s.name)}
                readOnly={readOnly}
                onSave={(name, config) => {
                  saveFor(props)(name, config);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : null}
            {editing && editing !== "new" && editing.source === "overridden" && !readOnly ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  state.resetInProject(editing.name);
                  setEditing(null);
                }}
              >
                Use environment config
              </Button>
            ) : null}
          </div>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function ThreadC() {
  const [provider, setProvider] = useState<SessionProvider>("Claude");
  return (
    <MockThread
      provider={provider}
      setProvider={setProvider}
      timelineExtra={
        <>
          <div className="ml-auto w-fit rounded-xl bg-secondary px-3 py-2 font-mono">/mcp</div>
          <div className="max-w-md space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs font-medium">
              <PlugIcon className="size-3.5" /> MCP servers in this {provider} session
            </div>
            <SessionList provider={provider} />
            <Button size="xs" variant="link">
              Open MCP settings →
            </Button>
          </div>
        </>
      }
      composerExtra={<span className="font-mono text-xs">/mcp</span>}
    />
  );
}

function MobileC(props: McpPrototypeProps) {
  const servers = useServers(props);
  return (
    <MobileFrame>
      <div className="px-4 pt-6 pb-2 text-lg font-semibold">MCP servers</div>
      <div className="space-y-2 p-3">
        {[BUILT_IN, ...servers].map((server) => (
          <div key={server.name} className="space-y-1 rounded-xl border p-3">
            <div className="flex items-center gap-2">
              <StatusDot server={server} />
              <span className="font-mono text-sm">{server.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{statusText(server)}</span>
            </div>
            {server.source !== "built-in" ? (
              <div className="text-[11px] text-muted-foreground">
                Works in: {PROVIDERS.filter((p) => supports(p, server.config.transport)).join(", ")}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <MobileNote />
    </MobileFrame>
  );
}

// ---------------------------------------------------------------------------
// Switcher wiring
// ---------------------------------------------------------------------------

export const MCP_PROTOTYPE_VARIANTS = [
  { key: "A", name: "Rows + inline edit" },
  { key: "B", name: "Master–detail" },
  { key: "C", name: "Provider matrix" },
] as const;
export type McpPrototypeSurface = "settings" | "thread" | "mobile";

export function McpServersPrototype({
  variant,
  surface,
  isProject,
  scopeLabel,
}: {
  variant: string;
  surface: McpPrototypeSurface;
  isProject: boolean;
  scopeLabel: string;
}) {
  const state = useMcpPrototypeState();
  const props: McpPrototypeProps = { state, isProject, scopeLabel, readOnly: surface === "mobile" };
  const views = {
    A: { settings: VariantA, thread: ThreadA, mobile: MobileA },
    B: { settings: VariantB, thread: ThreadB, mobile: MobileB },
    C: { settings: VariantC, thread: ThreadC, mobile: MobileC },
  } as const;
  const View = (views[variant as keyof typeof views] ?? views.A)[surface];
  return (
    <div className="space-y-6">
      <View {...props} />
      <details className="rounded-lg border border-dashed border-fuchsia-500/50 p-3 text-xs">
        <summary className="cursor-pointer text-fuchsia-500">Prototype state</summary>
        <pre className="mt-2 overflow-x-auto font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(
            {
              variant,
              surface,
              scope: isProject ? `project (${scopeLabel})` : `environment (${scopeLabel})`,
              "settings.mcpServers": state.global,
              "projectSettingsOverrides.mcpServers": isProject ? state.project : "(not shown)",
              mcpServerChecks: state.checks,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
