import type { McpRowTone } from "@t3tools/client-runtime/state/mcp-server-checks";
import type { McpSessionServerStatusValue } from "@t3tools/contracts";
import { View } from "react-native";

import { cn } from "../../lib/cn";

/** Dot and text colors for a read-only MCP status, shared by Settings and the thread sheet. */
export const MCP_TONE_DOT_CLASS = {
  neutral: "bg-foreground-muted",
  success: "bg-adaptive-emerald-600-400",
  warning: "bg-adaptive-amber-700-400",
  error: "bg-adaptive-rose-600-400",
} as const satisfies Record<McpRowTone, string>;

export const MCP_TONE_TEXT_CLASS = {
  neutral: "text-foreground-muted",
  success: "text-adaptive-emerald-600-400",
  warning: "text-adaptive-amber-700-400",
  error: "text-adaptive-rose-600-400",
} as const satisfies Record<McpRowTone, string>;

/** A session status as a tone; `connecting` and `unknown` carry no verdict yet. */
export const mcpSessionStatusTone = (status: McpSessionServerStatusValue): McpRowTone => {
  switch (status) {
    case "connected":
      return "success";
    case "needs-auth":
      return "warning";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
};

export function McpStatusDot({ tone }: { readonly tone: McpRowTone }) {
  return <View className={cn("h-2 w-2 shrink-0 rounded-full", MCP_TONE_DOT_CLASS[tone])} />;
}
