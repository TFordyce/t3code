/**
 * The form that adds a server to Claude's own config, opened from the
 * "Claude's servers" header and the thread MCP panel's "Add to Claude". Claude's CLI writes the server on the
 * environment's host, so it reaches plain `claude` and every other Claude Code
 * host there, and new Claude sessions in T3.
 *
 * @module ClaudeMcpAddForm
 */
import {
  claudeMcpServerNameError,
  ClaudeMcpHttpServerConfig,
  MCP_HEADER_NAME_PATTERN,
  type AddClaudeMcpServerInput,
  type ClaudeMcpAddScope,
  type ClaudeMcpAddServerConfig,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const SCOPE_NOTES: Record<ClaudeMcpAddScope, string> = {
  user: "Saved to Claude's user config on this environment, for every project.",
  local: "Saved to Claude's local config, private to this project on this environment.",
};

type Transport = ClaudeMcpAddServerConfig["type"];

/** An env variable or header while editing. */
interface PairRow {
  /** Stable React key: rows are removed from the middle. */
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

const isHttpUrl = Schema.is(ClaudeMcpHttpServerConfig.fields.url);

const filledNames = (rows: ReadonlyArray<PairRow>) =>
  rows.map((row) => row.name.trim()).filter((name) => name.length > 0);

const recordFrom = (rows: ReadonlyArray<PairRow>) =>
  Object.fromEntries(
    rows.filter((row) => row.name.trim().length > 0).map((row) => [row.name.trim(), row.value]),
  );

const hasUnnamedValue = (rows: ReadonlyArray<PairRow>) =>
  rows.some((row) => row.name.trim().length === 0 && row.value.length > 0);

function envError(rows: ReadonlyArray<PairRow>): string | undefined {
  const names = filledNames(rows);
  if (hasUnnamedValue(rows)) return "Each variable needs a name.";
  if (new Set(names).size !== names.length) return "Each variable can be set once.";
  return undefined;
}

function headersError(rows: ReadonlyArray<PairRow>): string | undefined {
  const names = filledNames(rows);
  if (hasUnnamedValue(rows)) return "Each header needs a name.";
  const invalid = names.find((name) => !MCP_HEADER_NAME_PATTERN.test(name));
  if (invalid !== undefined) return `"${invalid}" is not a valid header name.`;
  // Header names are case-insensitive, so two spellings are one header.
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return "Each header can be set once.";
  }
  return undefined;
}

export function ClaudeMcpAddForm(props: {
  readonly environmentId: EnvironmentId;
  /** The directory the list was probed in, re-probed after the add; a local add runs there. */
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
  /** The scopes offered, the first being the default; one scope shows no choice. */
  readonly scopes: readonly [ClaudeMcpAddScope, ...ClaudeMcpAddScope[]];
  /** Servers T3 configures here; Claude may not reuse their names. */
  readonly t3Names: ReadonlyArray<string>;
  readonly onCancel: () => void;
  readonly onAdded: (name: string) => void;
}) {
  const add = useAtomCommand(serverEnvironment.addClaudeMcpServer, {
    label: "add Claude MCP server",
    reportFailure: false,
  });
  const [scope, setScope] = useState(props.scopes[0]);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<ReadonlyArray<PairRow>>([]);
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<ReadonlyArray<PairRow>>([]);
  const nextKey = useRef(0);
  const newRow = (): PairRow => ({ key: nextKey.current++, name: "", value: "" });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const stdio = transport === "stdio";
  // Only the chosen transport's fields count; the other's stay as typed.
  const errors = {
    name: claudeMcpServerNameError(name.trim(), props.t3Names),
    command:
      stdio && command.trim().length === 0
        ? "Enter the command that starts the server."
        : undefined,
    env: stdio ? envError(env) : undefined,
    url: !stdio && !isHttpUrl(url.trim()) ? "Enter the server's http(s) URL." : undefined,
    headers: stdio ? undefined : headersError(headers),
  };
  const hasErrors = Object.values(errors).some((error) => error !== undefined);

  const submit = async () => {
    const server: ClaudeMcpAddServerConfig =
      transport === "stdio"
        ? {
            type: "stdio",
            command: command.trim(),
            args: args
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
            env: recordFrom(env),
          }
        : { type: "http", url: url.trim(), headers: recordFrom(headers) };
    const input: AddClaudeMcpServerInput = {
      cwd: props.cwd,
      ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
      name: name.trim(),
      scope,
      server,
    };
    const result = await add({ environmentId: props.environmentId, input });
    if (AsyncResult.isSuccess(result)) {
      props.onAdded(input.name);
      return;
    }
    const error = Cause.squash(result.cause);
    setFailure(error instanceof Error ? error.message : "Claude could not add the MCP server.");
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (hasErrors || saving) return;
        setSaving(true);
        setFailure(null);
        void submit().finally(() => setSaving(false));
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-foreground">Name</span>
        <Input
          aria-label="Server name"
          aria-invalid={touched && errors.name !== undefined}
          autoCapitalize="none"
          spellCheck={false}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {touched && errors.name ? <FieldError>{errors.name}</FieldError> : null}
      </label>
      <ToggleGroup
        aria-label="Transport"
        variant="segmented"
        value={[transport]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "stdio" || value === "http") setTransport(value);
        }}
      >
        <Toggle value="stdio">Command</Toggle>
        <Toggle value="http">HTTP</Toggle>
      </ToggleGroup>
      {transport === "stdio" ? (
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
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            {touched && errors.command ? <FieldError>{errors.command}</FieldError> : null}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Arguments, one per line</span>
            <Textarea
              aria-label="Arguments"
              spellCheck={false}
              placeholder={"-y\n@modelcontextprotocol/server-github"}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <PairRows
            title="Environment variables"
            noun="variable"
            namePlaceholder="NAME"
            rows={env}
            onChange={setEnv}
            newRow={newRow}
            error={touched ? errors.env : undefined}
          />
        </>
      ) : (
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
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            {touched && errors.url ? <FieldError>{errors.url}</FieldError> : null}
          </label>
          <PairRows
            title="Headers"
            noun="header"
            namePlaceholder="Authorization"
            rows={headers}
            onChange={setHeaders}
            newRow={newRow}
            error={touched ? errors.headers : undefined}
          />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Claude saves environment variables and headers as plain text in ~/.claude.json.
      </p>
      {props.scopes.length > 1 ? (
        <ToggleGroup
          aria-label="Scope"
          variant="segmented"
          value={[scope]}
          onValueChange={(next) => {
            const picked = props.scopes.find((candidate) => candidate === next[0]);
            if (picked !== undefined) setScope(picked);
          }}
        >
          {props.scopes.map((candidate) => (
            <Toggle key={candidate} value={candidate}>
              {candidate === "local" ? "Local" : "User"}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {SCOPE_NOTES[scope]} It applies to new Claude sessions.
      </p>
      {failure === null ? null : (
        <Alert variant="error">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={saving || (touched && hasErrors)}>
          {saving ? "Adding" : "Add to Claude"}
        </Button>
      </div>
    </form>
  );
}

/** Name and value rows for env variables or headers. */
function PairRows(props: {
  readonly title: string;
  /** Lowercase, as in "Add variable" and "Variable name". */
  readonly noun: string;
  readonly namePlaceholder: string;
  readonly rows: ReadonlyArray<PairRow>;
  readonly onChange: (rows: ReadonlyArray<PairRow>) => void;
  readonly newRow: () => PairRow;
  readonly error: string | undefined;
}) {
  const label = props.noun.charAt(0).toUpperCase() + props.noun.slice(1);
  const setRow = (index: number, row: PairRow) =>
    props.onChange(props.rows.map((existing, at) => (at === index ? row : existing)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{props.title}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => props.onChange([...props.rows, props.newRow()])}
        >
          <PlusIcon aria-hidden />
          Add {props.noun}
        </Button>
      </div>
      {props.rows.map((row, index) => (
        <div key={row.key} className="flex items-center gap-2">
          <Input
            aria-label={`${label} name`}
            font="mono"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={props.namePlaceholder}
            value={row.name}
            onChange={(event) => setRow(index, { ...row, name: event.target.value })}
          />
          <Input
            aria-label={`${label} value`}
            font="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="value"
            value={row.value}
            onChange={(event) => setRow(index, { ...row, value: event.target.value })}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${props.noun}`}
            onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      {props.error ? <FieldError>{props.error}</FieldError> : null}
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

/** Confirms an add, which only new Claude sessions pick up. */
export function ClaudeMcpAddedNotice(props: {
  readonly name: string;
  readonly onDismiss: () => void;
}) {
  return (
    <Alert variant="success">
      <AlertDescription>Added {props.name}. It applies to new Claude sessions.</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}
