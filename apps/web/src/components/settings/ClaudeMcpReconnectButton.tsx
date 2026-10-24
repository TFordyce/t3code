/**
 * The Reconnect control for one Claude MCP server. With `threadId` (the thread
 * panel) it reconnects the thread's running Claude process, then calls
 * `onReconnected` to re-probe. On global Settings there is no thread, and
 * Reconnect is just `onReconnected`: each fresh probe starts a new Claude
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
  onReconnected,
  size = "xs",
}: {
  readonly environmentId: EnvironmentId;
  /** The thread whose running Claude process reconnects; absent on global Settings. */
  readonly threadId?: ThreadId | undefined;
  readonly name: string;
  /** Asks Claude again: after a live reconnect, or on its own without a thread. */
  readonly onReconnected?: (() => void) | undefined;
  readonly size?: ComponentProps<typeof Button>["size"];
}) {
  const canReconnect = useAtomValue(
    serverEnvironment.reconnectClaudeMcpServer.permissionAtom(environmentId),
  );
  const reconnect = useAtomCommand(serverEnvironment.reconnectClaudeMcpServer, {
    label: "reconnect Claude MCP server",
  });
  if (!canReconnect) return null;
  const unavailable = threadId === undefined && onReconnected === undefined;
  return (
    <Button
      size={size}
      variant="outline"
      disabled={unavailable}
      title={unavailable ? NO_ACTIVE_SESSION_REASON : undefined}
      onClick={() => {
        if (threadId === undefined) {
          onReconnected?.();
          return;
        }
        void reconnect({ environmentId, input: { threadId, name } }).then((result) => {
          if (AsyncResult.isSuccess(result)) onReconnected?.();
        });
      }}
    >
      Reconnect
    </Button>
  );
}
