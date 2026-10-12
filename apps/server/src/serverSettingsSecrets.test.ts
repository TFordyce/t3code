import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  SECRET_REDACTED,
  planSettingsSecretPersist,
  redactSettingsSecrets,
  type SecretKind,
} from "./serverSettingsSecrets.ts";

// A stand-in for a future secret-bearing field, held in the unrelated `bitbucket.apiToken` string.
const extraKind: SecretKind = {
  map: (settings, visit) => {
    const raw = settings.bitbucket.apiToken;
    const next = visit({
      key: "extra-secret",
      sensitive: true,
      redacted: raw === SECRET_REDACTED,
      value: raw === SECRET_REDACTED ? "" : raw,
    });
    if (next === undefined) return settings;
    const apiToken = next.redacted && !next.resolved ? SECRET_REDACTED : next.value;
    return { ...settings, bitbucket: { ...settings.bitbucket, apiToken } };
  },
};

const withToken = (apiToken: string): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  bitbucket: { ...DEFAULT_SERVER_SETTINGS.bitbucket, apiToken },
});

describe("settings secret walker", () => {
  it("covers a newly registered kind with no walker code", () => {
    const kinds = [extraKind];
    expect(redactSettingsSecrets(withToken("hunter2"), kinds).bitbucket.apiToken).toBe(
      SECRET_REDACTED,
    );

    const saved = planSettingsSecretPersist(withToken(""), withToken("hunter2"), kinds);
    expect(saved.settings.bitbucket.apiToken).toBe(SECRET_REDACTED);
    expect(saved.changes.map((c) => [c.kind, c.secretName])).toEqual([["write", "extra-secret"]]);

    const kept = planSettingsSecretPersist(
      withToken(SECRET_REDACTED),
      withToken(SECRET_REDACTED),
      kinds,
    );
    expect(kept.changes).toEqual([]);

    const removed = planSettingsSecretPersist(withToken(SECRET_REDACTED), withToken(""), kinds);
    expect(removed.changes.map((c) => c.kind)).toEqual(["remove"]);
  });
});
