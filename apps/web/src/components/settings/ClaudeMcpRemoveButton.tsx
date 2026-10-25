/**
 * Remove for one user or local Claude MCP server. After a confirm step it runs
 * `claude mcp remove` on the environment's host, which re-probes the list, then
 * calls `onRemoved` to re-read it. Claude's own error stays in the confirm
 * dialog. Hidden when the session lacks the grant, since the server would
 * refuse the request, and for a local server outside a project.
 *
 * @module ClaudeMcpRemoveButton
 */
import type { ClaudeMcpScope, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function ClaudeMcpRemoveButton(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly scope: ClaudeMcpScope;
  /** The directory the list was probed in, which the server re-probes. */
  readonly cwd: string;
  /** The list's project; a local server is removed from this project. */
  readonly projectId?: ProjectId | undefined;
  /** Re-reads the list once the server is removed. */
  readonly onRemoved?: (() => void) | undefined;
  /** Held while a probe is already running. */
  readonly disabled?: boolean | undefined;
}) {
  const canRemove = useAtomValue(
    serverEnvironment.removeClaudeMcpServer.permissionAtom(props.environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.removeClaudeMcpServer, {
    label: "remove Claude MCP server",
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cwd, name, projectId } = props;
  const input =
    props.scope === "user"
      ? { scope: "user" as const, name, cwd, projectId }
      : projectId === undefined
        ? null
        : { scope: "local" as const, name, cwd, projectId };
  if (!canRemove || input === null) return null;

  const confirm = () => {
    setRemoving(true);
    setError(null);
    void remove({
      environmentId: props.environmentId,
      input,
    }).then((result) => {
      setRemoving(false);
      if (AsyncResult.isSuccess(result)) {
        setConfirming(false);
        props.onRemoved?.();
        return;
      }
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : "Claude could not remove the server.");
    });
  };

  return (
    <>
      <Button
        variant="destructive-outline"
        disabled={props.disabled === true}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Remove
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => (removing ? null : setConfirming(open))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {props.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Claude removes it from its {props.scope} config, so plain claude and other Claude
              hosts stop loading it too. Running sessions keep it until they restart.
            </AlertDialogDescription>
            {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removing} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={removing} onClick={confirm}>
              Remove server
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
