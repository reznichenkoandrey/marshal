import { describe, expect, it } from "vitest";

import { withUserBinDirs } from "../desktop/user-path.ts";

describe("withUserBinDirs (#349)", () => {
  it("adds the CLI install dirs to launchd's PATH", () => {
    expect(withUserBinDirs("/usr/bin:/bin:/usr/sbin:/sbin", "/Users/me")).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin"
    );
  });

  it("keeps a shell PATH as is when the dirs are already there", () => {
    const shellPath = "/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin:/usr/bin";
    expect(withUserBinDirs(shellPath, "/Users/me")).toBe(shellPath);
  });

  it("works without any PATH", () => {
    expect(withUserBinDirs(undefined, "/Users/me")).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin");
  });
});
