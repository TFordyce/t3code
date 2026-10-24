/**
 * What Claude reports about one of its MCP servers, opened from a Claude-only
 * row. The detail is read from the server's cached probe (probing on a miss)
 * and follows the list in place when it is refreshed.
 *
 * @module ClaudeMcpServerDialog
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  claudeMcpDetailView,
  type ClaudeMcpTone,
} from "@t3tools/client-runtime/state/claude-mcp-rows";
import type { ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

const TONE_CLASS: Record<ClaudeMcpTone, string> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words text-foreground">{props.children}</dd>
    </div>
  );
}

function ClaudeMcpServerDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
  readonly name: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.claudeMcpServerDetail({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
        name: props.name,
      },
    }),
  );
  const view = claudeMcpDetailView(query);
  switch (view.kind) {
    case "loading":
      return (
        <div className="flex items-center gap-2 text-sm">
          <Spinner className="size-3.5" />
          <span className="text-muted-foreground">Asking Claude about this server...</span>
        </div>
      );
    case "error":
    case "missing":
      return <p className="text-sm text-muted-foreground">{view.message}</p>;
    case "server":
      return (
        <dl className="space-y-2">
          <Field label="Status">
            <span className="flex items-center gap-2">
              <span className={TONE_CLASS[view.tone]}>{view.statusText}</span>
              {view.refreshing ? <Spinner className="size-3.5" /> : null}
            </span>
            {view.error === undefined ? null : (
              <span className="block text-xs text-destructive">{view.error}</span>
            )}
          </Field>
          {view.serverInfo === undefined ? null : <Field label="Server">{view.serverInfo}</Field>}
          {view.transport === undefined ? null : (
            <Field label="Transport">
              {view.transport}
              {view.target === undefined ? null : (
                <span className="block font-mono text-xs text-muted-foreground">{view.target}</span>
              )}
            </Field>
          )}
          {view.location === undefined ? null : <Field label="Config">{view.location}</Field>}
          <Field label="Tools">{view.toolCountText}</Field>
        </dl>
      );
  }
}

export function ClaudeMcpServerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
  /** The open server's name; null keeps the dialog closed. */
  readonly name: string | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={props.name !== null} onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.name}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {props.name === null ? null : (
            <ClaudeMcpServerDetail
              environmentId={props.environmentId}
              cwd={props.cwd}
              projectId={props.projectId}
              name={props.name}
            />
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
