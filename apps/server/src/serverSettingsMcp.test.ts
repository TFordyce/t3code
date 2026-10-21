import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { ProjectId, type McpServerConfig, type ServerSettingsPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { mcpSignInSecretKey } from "./settingsSecrets.ts";
const stdioOf = (server: McpServerConfig | undefined) =>
  server?.transport === "stdio" ? server : undefined;

const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-settings-test-" })),
    ),
  );

const encode = (value: string) => Buffer.from(value).toString("base64url");
const tokenKey = `mcp-env-${encode("global")}-${encode("gh")}-${encode("TOKEN")}`;

const projectId = ProjectId.make("project-a");
const projectTokenKey = `mcp-env-${encode(`project:${projectId}`)}-${encode("gh")}-${encode("TOKEN")}`;

const addProjectOverride = (token: string): ServerSettingsPatch => ({
  projectSettingsOverrides: {
    [projectId]: {
      mcpServers: {
        gh: {
          transport: "stdio",
          command: "npx",
          args: [],
          env: [{ name: "TOKEN", value: token, sensitive: true }],
        },
        off: { enabled: false },
      },
    },
  },
});

const addServer = (token: string): ServerSettingsPatch => ({
  mcpServers: {
    gh: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "gh-mcp"],
      env: [{ name: "TOKEN", value: token, sensitive: true }],
    },
  },
});

it.layer(NodeServices.layer)("server settings mcpServers", (it) => {
  it.effect("keeps secret env values in the store, out of the file and client views", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;

      yield* settings.updateSettings(addServer("ghp_secret"));

      const onDisk = yield* fileSystem.readFileString(config.settingsPath);
      assert.notInclude(onDisk, "ghp_secret");
      assert.include(onDisk, '"valueRedacted": true');
      const stored = yield* store.get(tokenKey);
      assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(stored)), "ghp_secret");

      // Server code sees the real value; a client never does.
      const materialized = yield* settings.getSettings;
      assert.strictEqual(stdioOf(materialized.mcpServers.gh)?.env[0]?.value, "ghp_secret");
      const forClient = ServerSettingsModule.redactServerSettingsForClient(materialized);
      assert.notInclude(JSON.stringify(forClient), "ghp_secret");
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("keeps the stored value when an edit sends the redacted row back", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.updateSettings(addServer("ghp_secret"));

      yield* settings.updateSettings({
        mcpServers: {
          gh: {
            transport: "stdio",
            command: "other-command",
            args: [],
            env: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
          },
        },
      });

      const next = yield* settings.getSettings;
      assert.strictEqual(stdioOf(next.mcpServers.gh)?.command, "other-command");
      assert.strictEqual(stdioOf(next.mcpServers.gh)?.env[0]?.value, "ghp_secret");
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("removing a server deletes its stored secrets", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* settings.updateSettings(addServer("ghp_secret"));

      yield* settings.updateSettings({ mcpServers: { gh: null } });

      assert.deepStrictEqual((yield* settings.getSettings).mcpServers, {});
      assert.isTrue(Option.isNone(yield* store.get(tokenKey)));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("keeps a project override's secrets apart from the environment entry's", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* settings.updateSettings(addServer("ghp_personal"));

      yield* settings.updateSettings(addProjectOverride("ghp_work"));

      const onDisk = yield* fileSystem.readFileString(config.settingsPath);
      assert.notInclude(onDisk, "ghp_work");
      const decode = (value: Option.Option<Uint8Array>) =>
        new TextDecoder().decode(Option.getOrThrow(value));
      assert.strictEqual(decode(yield* store.get(tokenKey)), "ghp_personal");
      assert.strictEqual(decode(yield* store.get(projectTokenKey)), "ghp_work");
      const forClient = ServerSettingsModule.redactServerSettingsForClient(
        yield* settings.getSettings,
      );
      assert.notInclude(JSON.stringify(forClient), "ghp_work");
      assert.deepStrictEqual(forClient.projectSettingsOverrides[projectId]?.mcpServers?.off, {
        enabled: false,
      });
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("clearing a project's MCP overrides deletes their stored secrets", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* settings.updateSettings(addProjectOverride("ghp_work"));

      yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });

      assert.deepStrictEqual((yield* settings.getSettings).projectSettingsOverrides, {});
      assert.isTrue(Option.isNone(yield* store.get(projectTokenKey)));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "a URL change deletes the sign-in; toggling enabled and project deletion follow the rules",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const http = (url: string, extra: Record<string, unknown> = {}) =>
          ({ transport: "http", url, headers: [], ...extra }) as const;
        const globalKey = mcpSignInSecretKey("global", "docs");
        const projectKey = mcpSignInSecretKey(`project:${projectId}`, "docs");
        yield* settings.updateSettings({
          mcpServers: { docs: http("https://a.example.com/mcp") },
          projectSettingsOverrides: {
            [projectId]: { mcpServers: { docs: http("https://p.example.com/mcp") } },
          },
        });
        const bundle = new TextEncoder().encode("{}");
        yield* store.set(globalKey, bundle);
        yield* store.set(projectKey, bundle);

        yield* settings.updateSettings({
          mcpServers: { docs: http("https://a.example.com/mcp", { enabled: false }) },
        });
        assert.isTrue(Option.isSome(yield* store.get(globalKey)));

        yield* settings.updateSettings({ mcpServers: { docs: http("https://b.example.com/mcp") } });
        assert.isTrue(Option.isNone(yield* store.get(globalKey)));
        assert.isTrue(Option.isSome(yield* store.get(projectKey)));

        yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: null } });
        assert.isTrue(Option.isNone(yield* store.get(projectKey)));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("drops an invalid stored entry and keeps the rest of the file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        config.settingsPath,
        JSON.stringify({
          worktreesDirectory: "kept",
          mcpServers: {
            good: { transport: "stdio", command: "ok" },
            "Not Valid": { transport: "stdio", command: "ok" },
            "t3-code-x": { transport: "stdio", command: "ok" },
          },
        }),
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService;

      const loaded = yield* settings.getSettings;

      assert.deepStrictEqual(Object.keys(loaded.mcpServers), ["good"]);
      assert.strictEqual(loaded.worktreesDirectory, "kept");
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("requires providers-manage only for a real change to project MCP servers", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const update = (patch: ServerSettingsPatch, canManageProviders: boolean) =>
        ServerSettingsModule.updateSettingsForClient({ patch, canManageProviders });

      const denied = yield* update(addProjectOverride("ghp_work"), false).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "ProvidersManageRequiredError");
      assert.deepStrictEqual((yield* settings.getSettings).projectSettingsOverrides, {});

      yield* update(addProjectOverride("ghp_work"), true);

      // A client resends the whole entry redacted; that is not a change.
      const resent = {
        projectSettingsOverrides: ServerSettingsModule.redactServerSettingsForClient(
          yield* settings.getSettings,
        ).projectSettingsOverrides,
      };
      yield* update(resent, false);
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
});
