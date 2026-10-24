import { mcpServerListRows } from "@t3tools/client-runtime/state/mcp-server-checks";
import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { McpStatusDot, MCP_TONE_TEXT_CLASS } from "../mcp/McpStatus";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";

const SOURCE_LABELS = {
  environment: "Environment",
  project: "This project",
  override: "Override",
} as const;

/**
 * Read-only view of the user MCP servers each selected environment gives its
 * agents. Editing, re-checking and sign-in live in T3 Code on desktop or web.
 */
export function SettingsMcpServersRouteScreen() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scoped = useMemo(
    () =>
      resolveMobileSettingsTargets(
        selectedTargets,
        selectedProjectKey === null
          ? null
          : (selectedProject?.members.map((member) => member.project) ?? []),
      ),
    [selectedProject, selectedProjectKey, selectedTargets],
  );
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="MCP servers" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            Edit and re-check MCP servers from T3 Code on desktop or the web.
          </Text>
          {scoped.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            scoped.map((target) => (
              <EnvironmentMcpServers
                key={`${target.environment.environmentId}:${target.projectId ?? ""}`}
                environment={target.environment}
                projectId={target.projectId}
              />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentMcpServers(props: {
  readonly environment: SettingsTarget;
  readonly projectId: Parameters<typeof mcpServerListRows>[0]["projectId"];
}) {
  const { serverConfig } = props.environment;
  const rows = useMemo(
    () =>
      mcpServerListRows({
        settings: serverConfig.settings,
        config: serverConfig,
        projectId: props.projectId,
      }),
    [props.projectId, serverConfig],
  );
  return (
    <SettingsSection title={props.environment.label}>
      {rows.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No MCP servers of your own.</Text>
      ) : (
        rows.map((row) => (
          <View
            key={`${row.source}:${row.name}`}
            accessible
            className="gap-1 border-b border-border p-4"
          >
            <View className="flex-row items-center gap-2">
              <McpStatusDot tone={row.tone} />
              <Text className="min-w-0 shrink text-base text-foreground" numberOfLines={1}>
                {row.name}
              </Text>
              {props.projectId === null ? null : (
                <Text className="rounded-full bg-foreground-muted/15 px-2 py-0.5 text-2xs text-foreground-muted">
                  {SOURCE_LABELS[row.source]}
                </Text>
              )}
            </View>
            <Text className={`text-sm ${MCP_TONE_TEXT_CLASS[row.tone]}`} numberOfLines={2}>
              {row.statusText}
            </Text>
            {row.signInNote ? (
              <Text className="text-sm text-foreground-muted">{row.signInNote}</Text>
            ) : null}
          </View>
        ))
      )}
    </SettingsSection>
  );
}
