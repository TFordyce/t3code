// PROTOTYPE route: throwaway, lives on branch prototype/mcp-servers-panel only.
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PrototypeSwitcher } from "../components/PrototypeSwitcher";
import {
  MCP_PROTOTYPE_VARIANTS,
  McpServersPrototype,
  type McpPrototypeSurface,
} from "../components/settings/McpServersPanel.prototype";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

const SURFACES: ReadonlyArray<McpPrototypeSurface> = ["settings", "thread", "mobile"];

function SettingsMcpServersPrototypeRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { scope } = useSettingsScope();
  const realProject = scope.kind === "project" || scope.kind === "checkout";
  const isProject = realProject || search.mockProject === true;
  const scopeLabel = realProject ? scope.label : isProject ? "t3code / This Mac" : scope.label;
  const variant = search.variant ?? "A";
  const surface = search.surface ?? "settings";

  return (
    <SettingsPageContainer>
      <McpServersPrototype
        key={`${variant}:${surface}:${isProject}`}
        variant={variant}
        surface={surface}
        isProject={isProject}
        scopeLabel={scopeLabel}
      />
      <div className="h-16" />
      <PrototypeSwitcher
        variants={MCP_PROTOTYPE_VARIANTS}
        current={variant}
        onChange={(next) =>
          void navigate({ search: (prev) => ({ ...prev, variant: next }), replace: true })
        }
      >
        <span className="mx-1 h-4 w-px bg-white/30" />
        {SURFACES.map((option) => (
          <button
            key={option}
            type="button"
            className={`rounded-full px-2 py-0.5 ${surface === option ? "bg-white text-zinc-950" : "hover:bg-white/15"}`}
            onClick={() =>
              void navigate({ search: (prev) => ({ ...prev, surface: option }), replace: true })
            }
          >
            {option}
          </button>
        ))}
        {realProject ? null : (
          <>
            <span className="mx-1 h-4 w-px bg-white/30" />
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${isProject ? "bg-white text-zinc-950" : "hover:bg-white/15"}`}
              onClick={() =>
                void navigate({
                  search: (prev) => ({ ...prev, mockProject: !isProject || undefined }),
                  replace: true,
                })
              }
            >
              project view
            </button>
          </>
        )}
      </PrototypeSwitcher>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/mcp-servers")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { variant?: string; surface?: McpPrototypeSurface; mockProject?: boolean | undefined } => ({
    ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}),
    ...(SURFACES.includes(raw.surface as McpPrototypeSurface)
      ? { surface: raw.surface as McpPrototypeSurface }
      : {}),
    ...(raw.mockProject === true || raw.mockProject === "true" ? { mockProject: true } : {}),
  }),
  component: SettingsMcpServersPrototypeRoute,
});
