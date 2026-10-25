import { describe, expect, it } from "vite-plus/test";

import { claudeMcpServerNameError } from "./claudeMcpStatus.ts";

describe("claudeMcpServerNameError", () => {
  it("accepts a fresh name, in any case", () => {
    expect(claudeMcpServerNameError("github", ["docs"])).toBeUndefined();
    expect(claudeMcpServerNameError("My_Server-2", [])).toBeUndefined();
  });

  it("refuses a name T3 already configures, since the list would merge the two", () => {
    expect(claudeMcpServerNameError("docs", ["docs"])).toBe(
      'T3 Code already has a server named "docs". Pick another name.',
    );
  });

  it("refuses the reserved t3-code prefix", () => {
    for (const name of ["t3-code", "t3-code-extra"]) {
      expect(claudeMcpServerNameError(name, [])).toBe(
        'Names starting with "t3-code" are reserved.',
      );
    }
  });

  it("refuses names Claude's CLI would misread or reject", () => {
    for (const name of ["", "-s", "has space", "dots.too"]) {
      expect(claudeMcpServerNameError(name, [])).toBe(
        "Use letters, digits, - or _, starting with a letter or digit.",
      );
    }
  });
});
