import {
  isMcpServerDisabledMarker,
  type McpServerConfig,
  type ProjectId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/**
 * Where a resolved server is configured: the environment list, a project
 * config that replaces an environment entry of the same name, or a server only
 * that project has.
 */
export type McpServerSource = "global" | "override" | "project";

export interface ResolvedMcpServer {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: McpServerSource;
}

/**
 * The user MCP servers a project's sessions get, in name order. The panel and
 * the session manager both read this, so what the panel shows is what sessions
 * receive. Project overrides merge per name over the environment entries: a
 * full config replaces (even a disabled environment entry), a bare marker turns
 * the environment entry off, and a name with no environment entry is
 * project-only. Disabled entries and markers drop out.
 */
export function resolveMcpServers(
  settings: Pick<ServerSettings, "mcpServers" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
): ReadonlyArray<ResolvedMcpServer> {
  const overrides =
    projectId === null ? undefined : settings.projectSettingsOverrides[projectId]?.mcpServers;
  const resolved = new Map<string, ResolvedMcpServer>();
  for (const [name, config] of Object.entries(settings.mcpServers)) {
    resolved.set(name, { name, config, source: "global" });
  }
  for (const [name, override] of Object.entries(overrides ?? {})) {
    if (isMcpServerDisabledMarker(override)) {
      resolved.delete(name);
    } else {
      resolved.set(name, {
        name,
        config: override,
        source: Object.hasOwn(settings.mcpServers, name) ? "override" : "project",
      });
    }
  }
  return [...resolved.values()]
    .filter(({ config }) => config.enabled !== false)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** JSON with sorted keys and no undefined members, so equal configs compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member !== null && typeof member === "object" && !Array.isArray(member)
      ? Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b)))
      : member,
  );
}

/**
 * Whether a settings patch changes any project's `mcpServers` overrides.
 * Clients resend a project's whole override entry, so a key check would flag
 * every project edit; this compares the incoming `mcpServers` with the stored
 * ones. `current` must be the redacted client view, since that is what clients
 * resend: a secret row sent back redacted is unchanged, a retyped one is not.
 */
export function patchChangesProjectMcpServers(
  current: Pick<ServerSettings, "projectSettingsOverrides">,
  patch: Pick<ServerSettingsPatch, "projectSettingsOverrides">,
): boolean {
  for (const [projectId, incoming] of Object.entries(patch.projectSettingsOverrides ?? {})) {
    const stored = current.projectSettingsOverrides[projectId as ProjectId]?.mcpServers ?? {};
    if (canonicalJson(incoming?.mcpServers ?? {}) !== canonicalJson(stored)) return true;
  }
  return false;
}
