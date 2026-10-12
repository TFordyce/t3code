import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { planSettingsSecretPersist, redactSettingsSecrets } from "./serverSettingsSecrets.ts";

const stdioWith = (env: ReadonlyArray<{ name: string; value: string; sensitive: boolean }>) =>
  ({ transport: "stdio", command: "npx", args: [], env }) as const;
const withMcp = (mcpServers: ServerSettings["mcpServers"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  mcpServers,
});
const encode = (value: string) => Buffer.from(value).toString("base64url");
const key = (server: string, variable: string) =>
  `mcp-env-${encode("global")}-${encode(server)}-${encode(variable)}`;

const mcpChanges = (plan: {
  readonly changes: ReadonlyArray<{ readonly kind: string; readonly secretName: string }>;
}) => plan.changes.filter((change) => change.secretName.startsWith("mcp-env-"));

const httpWith = (headers: ReadonlyArray<{ name: string; value: string; sensitive: boolean }>) =>
  ({ transport: "http", url: "https://mcp.example.com/mcp", headers }) as const;
const headerKey = (server: string, header: string) =>
  `mcp-header-${encode("global")}-${encode(server)}-${encode(header)}`;

describe("MCP server header secrets", () => {
  it("stores sensitive headers in the secret store and redacts them for clients", () => {
    const saved = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({
        docs: httpWith([
          { name: "Authorization", value: "Bearer s3cret", sensitive: true },
          { name: "X-Mode", value: "fast", sensitive: false },
        ]),
      }),
    );
    const docs = saved.settings.mcpServers.docs;
    expect(docs?.transport === "http" ? docs.headers : []).toEqual([
      { name: "Authorization", value: "", sensitive: true, valueRedacted: true },
      { name: "X-Mode", value: "fast", sensitive: false },
    ]);
    expect(
      saved.changes.filter((change) => change.secretName.startsWith("mcp-header-")),
    ).toMatchObject([
      { kind: "write", secretName: headerKey("docs", "Authorization") },
      { kind: "remove", secretName: headerKey("docs", "X-Mode") },
    ]);
    expect(
      JSON.stringify(
        redactSettingsSecrets(
          withMcp({
            docs: httpWith([{ name: "Authorization", value: "Bearer s3cret", sensitive: true }]),
          }),
        ),
      ),
    ).not.toContain("s3cret");
  });

  it("sweeps the header secrets of a removed server", () => {
    const stored = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({
        docs: httpWith([{ name: "Authorization", value: "Bearer s3cret", sensitive: true }]),
      }),
    ).settings;
    const removed = planSettingsSecretPersist(stored, withMcp({}));
    expect(
      removed.changes.filter((change) => change.secretName.startsWith("mcp-header-")),
    ).toMatchObject([{ kind: "remove", secretName: headerKey("docs", "Authorization") }]);
  });
});

describe("MCP server env secrets", () => {
  it("stores sensitive values, leaves plain ones, and redacts for clients", () => {
    const saved = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({
        gh: stdioWith([
          { name: "TOKEN", value: "ghp_secret", sensitive: true },
          { name: "MODE", value: "fast", sensitive: false },
        ]),
      }),
    );
    expect(saved.settings.mcpServers.gh?.env).toEqual([
      { name: "TOKEN", value: "", sensitive: true, valueRedacted: true },
      { name: "MODE", value: "fast", sensitive: false },
    ]);
    // A plain row is cleared from the store in case it was sensitive before.
    expect(mcpChanges(saved).map((change) => [change.kind, change.secretName])).toEqual([
      ["write", key("gh", "TOKEN")],
      ["remove", key("gh", "MODE")],
    ]);
    expect(JSON.stringify(redactSettingsSecrets(withMcp(saved.settings.mcpServers)))).not.toContain(
      "ghp_secret",
    );
  });

  it("redacts a plaintext value held in memory before it reaches a client", () => {
    const redacted = redactSettingsSecrets(
      withMcp({ gh: stdioWith([{ name: "TOKEN", value: "ghp_secret", sensitive: true }]) }),
    );
    expect(JSON.stringify(redacted)).not.toContain("ghp_secret");
    expect(redacted.mcpServers.gh?.env[0]?.valueRedacted).toBe(true);
  });

  it("keeps a stored value when a redacted row is sent back", () => {
    const stored = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({ gh: stdioWith([{ name: "TOKEN", value: "ghp_secret", sensitive: true }]) }),
    ).settings;
    const edited = withMcp({
      gh: {
        ...stdioWith([]),
        command: "other",
        env: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
      },
    });
    const kept = planSettingsSecretPersist(stored, edited);
    expect(mcpChanges(kept)).toEqual([]);
    expect(kept.settings.mcpServers.gh?.env[0]?.valueRedacted).toBe(true);
  });

  it("sweeps the secrets of a removed server", () => {
    const stored = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({ gh: stdioWith([{ name: "TOKEN", value: "ghp_secret", sensitive: true }]) }),
    ).settings;
    const removed = planSettingsSecretPersist(stored, withMcp({}));
    expect(mcpChanges(removed)).toEqual([
      expect.objectContaining({ kind: "remove", secretName: key("gh", "TOKEN") }),
    ]);
  });
});

describe("project MCP override secrets", () => {
  const projectId = ProjectId.make("project-a");
  const withProjectMcp = (mcpServers: NonNullable<ProjectSettingsOverrides["mcpServers"]>) =>
    ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { mcpServers } },
    }) as ServerSettings;
  const projectEnvKey = (server: string, variable: string) =>
    `mcp-env-${encode(`project:${projectId}`)}-${encode(server)}-${encode(variable)}`;
  const projectHeaderKey = (server: string, header: string) =>
    `mcp-header-${encode(`project:${projectId}`)}-${encode(server)}-${encode(header)}`;

  it("stores a project override's secrets under a project-scoped key and redacts them", () => {
    const saved = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withProjectMcp({
        gh: stdioWith([{ name: "TOKEN", value: "ghp_work", sensitive: true }]),
        docs: httpWith([{ name: "Authorization", value: "Bearer work", sensitive: true }]),
        off: { enabled: false },
      }),
    );
    const stored = saved.settings.projectSettingsOverrides[projectId]?.mcpServers;
    expect(JSON.stringify(stored)).not.toContain("ghp_work");
    expect(stored?.off).toEqual({ enabled: false });
    expect(
      saved.changes.filter((c) => c.kind === "write").map((change) => change.secretName),
    ).toEqual([projectEnvKey("gh", "TOKEN"), projectHeaderKey("docs", "Authorization")]);
    expect(
      JSON.stringify(
        redactSettingsSecrets(
          withProjectMcp({
            gh: stdioWith([{ name: "TOKEN", value: "ghp_work", sensitive: true }]),
          }),
        ),
      ),
    ).not.toContain("ghp_work");
  });

  it("keeps global and project secrets of the same server name apart", () => {
    const global = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withMcp({ gh: stdioWith([{ name: "TOKEN", value: "personal", sensitive: true }]) }),
    ).settings;
    const both = planSettingsSecretPersist(global, {
      ...global,
      projectSettingsOverrides: {
        [projectId]: {
          mcpServers: { gh: stdioWith([{ name: "TOKEN", value: "work", sensitive: true }]) },
        },
      },
    });
    const writes = both.changes.filter((change) => change.kind === "write");
    expect(writes.map((change) => change.secretName)).toEqual([projectEnvKey("gh", "TOKEN")]);
    // The global row stays redacted, so its stored value is kept.
    expect(both.changes.some((c) => c.secretName === key("gh", "TOKEN"))).toBe(false);
  });

  it("sweeps a project's secrets when its overrides are removed", () => {
    const stored = planSettingsSecretPersist(
      DEFAULT_SERVER_SETTINGS,
      withProjectMcp({ gh: stdioWith([{ name: "TOKEN", value: "work", sensitive: true }]) }),
    ).settings;
    const removed = planSettingsSecretPersist(stored, {
      ...stored,
      projectSettingsOverrides: {},
    });
    expect(removed.changes.filter((c) => c.secretName.startsWith("mcp-"))).toMatchObject([
      {
        kind: "remove",
        operation: "remove-stale-secret",
        secretName: projectEnvKey("gh", "TOKEN"),
      },
    ]);
  });
});
