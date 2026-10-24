/**
 * The Reconnect control for one Claude MCP server. With `threadId` (the thread
 * panel) it reconnects the thread's running Claude process, then calls
 * `onReprobe` to ask Claude again. On global Settings there is no thread, and
 * Reconnect is just `onReprobe`: each fresh probe starts a new Claude
 * process. With neither it is disabled with its reason. Hidden when the
 * session lacks the grant, since the server would refuse the request.
 *
 * @module ClaudeMcpReconnectButton
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const NO_ACTIVE_SESSION_REASON = "No active session";

export function ClaudeMcpReconnectButton({
  environmentId,
  threadId,
  name,
  onReprobe,
  disabled = false,
  size = "xs",
}: {
  readonly environmentId: EnvironmentId;
  /** The thread whose running Claude process reconnects; absent on global Settings. */
  readonly threadId?: ThreadId | undefined;
  readonly name: string;
  /** Asks Claude again: after a live reconnect, or on its own without a thread. */
  readonly onReprobe?: (() => void) | undefined;
  /** Held while a probe is already running. */
  readonly disabled?: boolean | undefined;
  readonly size?: ComponentProps<typeof Button>["size"];
}) {
  const canReconnect = useAtomValue(
    serverEnvironment.reconnectClaudeMcpServer.permissionAtom(environmentId),
  );
  const reconnect = useAtomCommand(serverEnvironment.reconnectClaudeMcpServer, {
    label: "reconnect Claude MCP server",
  });
  if (!canReconnect) return null;
  const unavailable = threadId === undefined && onReprobe === undefined;
  return (
    <Button
      size={size}
      variant="outline"
      disabled={unavailable || disabled}
      title={unavailable ? NO_ACTIVE_SESSION_REASON : undefined}
      onClick={() => {
        if (threadId === undefined) {
          onReprobe?.();
          return;
        }
        void reconnect({ environmentId, input: { threadId, name } }).then((result) => {
          if (AsyncResult.isSuccess(result)) onReprobe?.();
        });
      }}
    >
      Reconnect
    </Button>
  );
}
