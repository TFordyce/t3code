import { describe, expect, it } from "vite-plus/test";

import { claudeMcpToggleFor } from "./claudeMcpToggle.logic";

describe("claudeMcpToggleFor", () => {
  it("offers Enable on a disabled row", () => {
    expect(claudeMcpToggleFor("disabled")).toEqual({ label: "Enable", enable: true });
  });

  it.each(["connected", "pending", "failed", "needs-auth"] as const)(
    "offers Disable on a %s row",
    (status) => {
      expect(claudeMcpToggleFor(status)).toEqual({ label: "Disable", enable: false });
    },
  );
});
