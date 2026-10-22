/**
 * The Reconnect control for one failed Claude MCP server. It reaches the
 * thread's running Claude process, so pass `threadId` from the thread panel;
 * on global Settings there is no thread and the button is disabled with its
 * reason. Hidden when the session lacks the grant, since the server would
 * refuse the request.
 *
 * @module ClaudeMcpReconnectButton
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
}: {
  readonly environmentId: EnvironmentId;
  /** The thread whose running Claude process reconnects; absent on global Settings. */
  readonly threadId?: ThreadId | undefined;
  readonly name: string;
  /** Called after Claude accepts the reconnect, so the list can re-probe. */
  readonly onReconnected?: (() => void) | undefined;
}) {
  const canReconnect = useAtomValue(
    serverEnvironment.reconnectClaudeMcpServer.permissionAtom(environmentId),
  );
  const reconnect = useAtomCommand(serverEnvironment.reconnectClaudeMcpServer, {
    label: "reconnect Claude MCP server",
  });
  if (!canReconnect) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={threadId === undefined}
      title={threadId === undefined ? NO_ACTIVE_SESSION_REASON : undefined}
      onClick={() => {
        if (threadId === undefined) return;
        void reconnect({ environmentId, input: { threadId, name } }).then((result) => {
          if (AsyncResult.isSuccess(result)) onReconnected?.();
        });
      }}
    >
      Reconnect
    </Button>
  );
}
