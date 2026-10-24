/**
 * What Claude reports about one of its MCP servers, opened from a Claude-only
 * row. The detail is read from the server's cached probe (probing on a miss)
 * and follows the list in place when it is refreshed, so Reconnect and
 * Enable/Disable (both followed by `onReconnected`, a fresh probe) update the
 * open dialog.
 *
 * @module ClaudeMcpServerDialog
 */
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  claudeMcpDetailView,
  type ClaudeMcpGuidance,
  type ClaudeMcpTone,
  type ClaudeMcpToolView,
} from "@t3tools/client-runtime/state/claude-mcp-rows";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { ClaudeMcpReconnectButton } from "./ClaudeMcpReconnectButton";
import { ClaudeMcpToggleButton } from "./ClaudeMcpToggleButton";

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

/** One tool; its description is the server author's text, so it stays plain text. */
function ClaudeMcpTool(props: { readonly tool: ClaudeMcpToolView }) {
  const { tool } = props;
  const heading = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-mono text-xs text-foreground">{tool.name}</span>
      {tool.readOnly ? <Badge variant="info">Read-only</Badge> : null}
      {tool.destructive ? <Badge variant="error">Destructive</Badge> : null}
    </span>
  );
  if (tool.description === undefined) return <li className="py-1.5">{heading}</li>;
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 text-left">
          {heading}
          <span className="w-full truncate text-xs text-muted-foreground group-data-panel-open:hidden">
            {tool.summary}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <p className="whitespace-pre-wrap break-words pb-1.5 text-xs text-muted-foreground">
            {tool.description}
          </p>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function ClaudeMcpTools(props: {
  readonly tools: ReadonlyArray<ClaudeMcpToolView>;
  readonly noToolsText?: string | undefined;
}) {
  if (props.noToolsText !== undefined) {
    return <p className="text-sm text-muted-foreground">{props.noToolsText}</p>;
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-foreground">
        <ChevronRightIcon aria-hidden className="size-3.5 group-data-panel-open:rotate-90" />
        View tools
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <ul className="mt-1 max-h-72 divide-y overflow-y-auto">
          {props.tools.map((tool) => (
            <ClaudeMcpTool key={tool.name} tool={tool} />
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

interface DetailTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
  readonly name: string;
}

function useClaudeMcpDetail(props: DetailTarget) {
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
  return claudeMcpDetailView(query);
}

function Guidance({ guidance }: { readonly guidance: ClaudeMcpGuidance }) {
  return guidance.kind === "link" ? (
    <a
      className="block text-xs text-info-foreground underline"
      href={guidance.href}
      target="_blank"
      rel="noreferrer"
    >
      {guidance.label}
    </a>
  ) : (
    <span className="block text-xs text-muted-foreground">{guidance.text}</span>
  );
}

function ClaudeMcpServerDetail(props: DetailTarget) {
  const view = useClaudeMcpDetail(props);
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
        <div className="space-y-3">
          <dl className="space-y-2">
            <Field label="Status">
              <span className="flex items-center gap-2">
                <span className={TONE_CLASS[view.tone]}>{view.statusText}</span>
                {view.refreshing ? <Spinner className="size-3.5" /> : null}
              </span>
              {view.error === undefined ? null : (
                <span className="block text-xs text-destructive">{view.error}</span>
              )}
              {view.guidance === undefined ? null : <Guidance guidance={view.guidance} />}
            </Field>
            {view.serverInfo === undefined ? null : <Field label="Server">{view.serverInfo}</Field>}
            {view.transport === undefined ? null : (
              <Field label="Transport">
                {view.transport}
                {view.target === undefined ? null : (
                  <span className="block font-mono text-xs text-muted-foreground">
                    {view.target}
                  </span>
                )}
              </Field>
            )}
            {view.location === undefined ? null : <Field label="Config">{view.location}</Field>}
            <Field label="Tools">{view.toolCountText}</Field>
          </dl>
          <ClaudeMcpTools tools={view.tools} noToolsText={view.noToolsText} />
        </div>
      );
  }
}

/** Reconnect and Enable/Disable for the open server, as the view-model offers them. */
function ClaudeMcpServerActions(
  props: DetailTarget & {
    readonly threadId?: ThreadId | undefined;
    readonly onReconnected?: (() => void) | undefined;
  },
) {
  const view = useClaudeMcpDetail(props);
  if (view.kind !== "server") return null;
  return (
    <>
      {view.actions.includes("reconnect") ? (
        <ClaudeMcpReconnectButton
          environmentId={props.environmentId}
          threadId={props.threadId}
          name={view.name}
          onReconnected={props.onReconnected}
          size="default"
        />
      ) : null}
      {view.actions.includes("enable") || view.actions.includes("disable") ? (
        <ClaudeMcpToggleButton
          environmentId={props.environmentId}
          projectId={props.projectId}
          name={view.name}
          status={view.status}
          onToggled={props.onReconnected}
          size="default"
        />
      ) : null}
    </>
  );
}

export function ClaudeMcpServerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
  /** The thread whose running Claude process Reconnect reaches; absent on Settings. */
  readonly threadId?: ThreadId | undefined;
  /** Asks Claude again; runs after Reconnect or a toggle, and is Reconnect without a thread. */
  readonly onReconnected?: (() => void) | undefined;
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
          {props.name === null ? null : (
            <ClaudeMcpServerActions
              environmentId={props.environmentId}
              cwd={props.cwd}
              projectId={props.projectId}
              threadId={props.threadId}
              onReconnected={props.onReconnected}
              name={props.name}
            />
          )}
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
