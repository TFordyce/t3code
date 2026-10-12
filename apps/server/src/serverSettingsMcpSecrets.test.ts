import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
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

const mcpChanges = (plan: { readonly changes: ReadonlyArray<{ readonly secretName: string }> }) =>
  plan.changes.filter((change) => change.secretName.startsWith("mcp-env-"));

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
