import type { ScopedThreadRef } from "@t3tools/contracts";

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

/** Body of the Agents right-panel surface: the same rows the thread details card lists. */
export function ThreadAgentsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-thread-agents-panel>
      <ThreadRelationshipsPanel
        environmentId={props.threadRef.environmentId}
        threadId={props.threadRef.threadId}
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No subagents or forks yet.
          </p>
        }
      />
    </div>
  );
}
