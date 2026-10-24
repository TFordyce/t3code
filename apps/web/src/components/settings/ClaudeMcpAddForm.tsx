/**
 * The form that adds a server to Claude's own config, opened from the
 * "Claude's servers" header. Claude's CLI writes the server on the
 * environment's host, so it reaches plain `claude` and every other Claude Code
 * host there, and new Claude sessions in T3.
 *
 * @module ClaudeMcpAddForm
 */
import {
  claudeMcpServerNameError,
  type AddClaudeMcpServerInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

interface EnvRow {
  /** Stable React key: rows are removed from the middle. */
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

function envError(rows: ReadonlyArray<EnvRow>): string | undefined {
  const names = rows.map((row) => row.name.trim()).filter((name) => name.length > 0);
  if (rows.some((row) => row.name.trim().length === 0 && row.value.length > 0)) {
    return "Each variable needs a name.";
  }
  if (new Set(names).size !== names.length) return "Each variable can be set once.";
  return undefined;
}

export function ClaudeMcpAddForm(props: {
  readonly environmentId: EnvironmentId;
  /** The directory the list was probed in, re-probed after the add. */
  readonly cwd: string;
  /** Servers T3 configures here; Claude may not reuse their names. */
  readonly t3Names: ReadonlyArray<string>;
  readonly onCancel: () => void;
  readonly onAdded: (name: string) => void;
}) {
  const add = useAtomCommand(serverEnvironment.addClaudeMcpServer, {
    label: "add Claude MCP server",
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<ReadonlyArray<EnvRow>>([]);
  const nextKey = useRef(0);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const errors = {
    name: claudeMcpServerNameError(name.trim(), props.t3Names),
    command: command.trim().length === 0 ? "Enter the command that starts the server." : undefined,
    env: envError(env),
  };
  const hasErrors = Object.values(errors).some((error) => error !== undefined);
  const setRow = (index: number, row: EnvRow) =>
    setEnv(env.map((existing, at) => (at === index ? row : existing)));

  const submit = async () => {
    const input: AddClaudeMcpServerInput = {
      cwd: props.cwd,
      name: name.trim(),
      scope: "user",
      server: {
        type: "stdio",
        command: command.trim(),
        args: args
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        env: Object.fromEntries(
          env
            .filter((row) => row.name.trim().length > 0)
            .map((row) => [row.name.trim(), row.value]),
        ),
      },
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
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Environment variables</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setEnv([...env, { key: nextKey.current++, name: "", value: "" }])}
          >
            <PlusIcon aria-hidden />
            Add variable
          </Button>
        </div>
        {env.map((row, index) => (
          <div key={row.key} className="flex items-center gap-2">
            <Input
              aria-label="Variable name"
              font="mono"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="NAME"
              value={row.name}
              onChange={(event) => setRow(index, { ...row, name: event.target.value })}
            />
            <Input
              aria-label="Variable value"
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
              aria-label="Remove variable"
              onClick={() => setEnv(env.filter((_, at) => at !== index))}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        ))}
        {touched && errors.env ? <FieldError>{errors.env}</FieldError> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Claude saves these as plain text in ~/.claude.json.
      </p>
      <p className="text-xs text-muted-foreground">
        Saved to Claude's user config on this environment, for every project. It applies to new
        Claude sessions.
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

function FieldError({ children }: { readonly children: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}
