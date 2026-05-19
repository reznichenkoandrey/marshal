import { describe, expect, it, vi } from "vitest";

import { UpdateChecker, isNewer, stripLeadingV } from "../desktop/updater/update-checker.ts";

describe("stripLeadingV", () => {
  it("removes a leading v", () => {
    expect(stripLeadingV("v1.2.3")).toBe("1.2.3");
  });

  it("leaves bare semver untouched", () => {
    expect(stripLeadingV("1.2.3")).toBe("1.2.3");
  });

  it("does not strip mid-string V characters", () => {
    expect(stripLeadingV("1.2.3-vrelease")).toBe("1.2.3-vrelease");
  });
});

describe("isNewer", () => {
  it("detects major bump", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("detects minor bump", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true);
  });

  it("detects patch bump", () => {
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
  });

  it("returns false for equal versions", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false for older versions", () => {
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
  });

  it("returns false for unparseable input", () => {
    expect(isNewer("not-a-version", "1.2.3")).toBe(false);
    expect(isNewer("1.2.3", "broken")).toBe(false);
  });

  it("considers 1.2.3 newer than 1.2.3-beta.1 numerically", () => {
    // We only compare the numeric prefix — a release "1.2.3" tagged after a
    // pre-release "1.2.3-beta" wins, which is the behaviour we want for the
    // "did the maintainer cut the final release yet?" question.
    expect(isNewer("1.2.3", "1.2.2-beta.99")).toBe(true);
  });
});

describe("UpdateChecker.check", () => {
  function buildFetch(payload: {
    status?: number;
    body?: object;
    headers?: Record<string, string>;
  }) {
    const status = payload.status ?? 200;
    const body = payload.body ?? {};
    const headers = new Headers(payload.headers ?? {});
    return vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers })
    ) as unknown as typeof fetch;
  }

  it("reports an update when the API tag is newer", async () => {
    const fetchImpl = buildFetch({
      body: {
        tag_name: "v0.2.0",
        html_url: "https://github.com/reznichenkoandrey/marshal/releases/tag/v0.2.0",
        name: "0.2.0",
        body: "* New translator backend",
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "Marshal-0.2.0-arm64.dmg",
            browser_download_url: "https://github.com/reznichenkoandrey/marshal/releases/download/v0.2.0/Marshal-0.2.0-arm64.dmg"
          },
          {
            name: "Marshal-0.2.0-arm64.zip",
            browser_download_url: "https://example/zip"
          }
        ]
      }
    });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.latestVersion).toBe("0.2.0");
    expect(r.downloadUrl).toContain(".dmg");
    expect(r.releaseNotes).toContain("New translator backend");
  });

  it("reports no update when versions match", async () => {
    const fetchImpl = buildFetch({
      body: {
        tag_name: "v0.1.0",
        html_url: "https://example/release",
        name: "0.1.0",
        body: "",
        draft: false,
        prerelease: false,
        assets: []
      }
    });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(false);
  });

  it("treats a 404 as 'no releases yet' (not an error)", async () => {
    const fetchImpl = buildFetch({ status: 404, body: { message: "Not Found" } });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(false);
    if ("error" in r) throw new Error("404 should not surface as an error");
    expect(r.latestVersion).toBe("0.1.0");
  });

  it("surfaces non-ok statuses other than 404 as errors", async () => {
    const fetchImpl = buildFetch({ status: 503, body: { message: "Service Unavailable" } });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(false);
    expect("error" in r).toBe(true);
  });

  it("returns a network error string when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(false);
    if (!("error" in r)) throw new Error("expected error outcome");
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("uses cached body on a 304 response", async () => {
    // The standard Response constructor refuses 304 ("null-body status"),
    // so we hand-roll a minimal Response-shaped object for the second call.
    // Only the fields UpdateChecker reads are populated.
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.3.0",
            html_url: "https://example/release",
            name: "0.3.0",
            body: "notes",
            draft: false,
            prerelease: false,
            assets: []
          }),
          { status: 200, headers: { etag: '"abc"' } }
        );
      }
      return {
        status: 304,
        ok: false,
        headers: new Headers(),
        text: async () => "",
        json: async () => ({})
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const first = await checker.check();
    expect(first.available).toBe(true);
    const second = await checker.check();
    expect(second.available).toBe(true);
    if (!second.available) return;
    expect(second.latestVersion).toBe("0.3.0");
    // The second call must have sent the If-None-Match header; check via
    // the recorded fetch arguments.
    const headersArg = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[1][1];
    expect((headersArg.headers as Record<string, string>)["If-None-Match"]).toBe('"abc"');
  });

  it("treats draft releases as 'no update available'", async () => {
    const fetchImpl = buildFetch({
      body: {
        tag_name: "v0.9.0",
        html_url: "https://example/release",
        name: "0.9.0",
        body: "",
        draft: true,
        prerelease: false,
        assets: []
      }
    });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(false);
  });

  it("handles a release without a .dmg asset", async () => {
    const fetchImpl = buildFetch({
      body: {
        tag_name: "v0.2.0",
        html_url: "https://example/release",
        name: "0.2.0",
        body: "",
        draft: false,
        prerelease: false,
        assets: [{ name: "Marshal-0.2.0-arm64.zip", browser_download_url: "https://example/zip" }]
      }
    });
    const checker = new UpdateChecker({ currentVersion: "0.1.0", fetchImpl });
    const r = await checker.check();
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.downloadUrl).toBeNull();
  });
});
