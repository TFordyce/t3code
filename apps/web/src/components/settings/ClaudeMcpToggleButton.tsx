/**
 * The Enable/Disable control for one Claude MCP server row. Shown on both the
 * Settings list and the thread panel: pass the project the row is scoped to,
 * or none for the environment-wide list. Hidden when the session lacks the
 * grant, since the server would refuse the change.
 *
 * @module ClaudeMcpToggleButton
 */
import type { ClaudeMcpServerStatusValue, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { claudeMcpToggleFor } from "./claudeMcpToggle.logic";

export function ClaudeMcpToggleButton({
  environmentId,
  projectId,
  name,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | undefined;
  readonly name: string;
  readonly status: ClaudeMcpServerStatusValue;
}) {
  const canToggle = useAtomValue(
    serverEnvironment.setClaudeMcpServerEnabled.permissionAtom(environmentId),
  );
  const toggle = useAtomCommand(serverEnvironment.setClaudeMcpServerEnabled, {
    label: "toggle Claude MCP server",
  });
  if (!canToggle) return null;
  const { label, enable } = claudeMcpToggleFor(status);
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() =>
        void toggle({
          environmentId,
          input: { name, enabled: enable, ...(projectId === undefined ? {} : { projectId }) },
        })
      }
    >
      {label}
    </Button>
  );
}
