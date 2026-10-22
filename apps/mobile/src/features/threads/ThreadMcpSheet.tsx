import { useAtomValue } from "@effect/atom-react";
import {
  mcpServerListRows,
  mcpThreadFallback,
  MCP_STATUS_LABELS,
  threadMcpRows,
} from "@t3tools/client-runtime/state/mcp-server-checks";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { MCP_TONE_TEXT_CLASS, McpStatusDot, mcpSessionStatusTone } from "../mcp/McpStatus";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type McpTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * Read-only MCP status of a thread's provider session, the same list the
 * desktop and web MCP tab shows. Managing servers happens on desktop or web.
 */
export function ThreadMcpSheet({ route }: StaticScreenProps<McpTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const sessionServers = useAtomValue(environmentThreadDetails.mcpSessionServersAtom(target));
  const config = useEnvironmentServerConfig(target.environmentId);
  const projectId = useThreadShell(target)?.projectId ?? null;
  const rows = useMemo(() => {
    const fallback =
      config?.settings === undefined
        ? { configuredNames: [] }
        : mcpThreadFallback(mcpServerListRows({ settings: config.settings, config, projectId }));
    return threadMcpRows({ sessionServers, ...fallback });
  }, [config, projectId, sessionServers]);

  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {rows.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No MCP servers of your own in this session. The built-in T3 Code server is always
          available.
        </Text>
      ) : (
        rows.map((row) => {
          const tone = mcpSessionStatusTone(row.status);
          return (
            <View key={row.name} accessible className="gap-1 border-b border-border py-3.5">
              <View className="flex-row items-center gap-2">
                <McpStatusDot tone={tone} />
                <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                  {row.name}
                </Text>
                <Text className={`shrink-0 text-sm ${MCP_TONE_TEXT_CLASS[tone]}`}>
                  {MCP_STATUS_LABELS[row.status]}
                </Text>
              </View>
              {row.detail ? (
                <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                  {row.detail}
                </Text>
              ) : null}
              {row.check ? (
                <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                  Server check: {MCP_STATUS_LABELS[row.check.status]}
                  {row.check.detail ? ` · ${row.check.detail}` : ""}
                </Text>
              ) : null}
            </View>
          );
        })
      )}
      <Text className="pt-4 text-sm text-foreground-muted">
        Manage MCP servers from T3 Code on desktop or the web.
      </Text>
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // Same nested native stack as the agents sheet: a plain formSheet screen
    // never renders a stack header.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-mcp-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="MCP servers"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="MCP servers" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}
