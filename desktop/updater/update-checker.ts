// desktop/updater/update-checker.ts
//
// "Is there a newer release on GitHub?" checker. Pulls the latest release via
// the GitHub Releases API, compares semver tags, and — when the release carries
// a `latest-mac.yml` metadata asset (which electron-builder publishes
// automatically) — surfaces the ZIP asset URL plus SHA-512 so the in-app
// installer (`./update-installer.ts`) can download and atomically swap the
// bundle without bouncing the user to a browser.
//
// We stay outside the electron-updater (Squirrel.Mac) ecosystem on purpose —
// that path needs a Developer ID-signed and notarized bundle, which we don't
// have yet (see #78). When notarization lands, this module remains the
// user-facing "Check for updates…" surface and electron-updater takes over the
// install step.

const RELEASES_API = "https://api.github.com/repos/reznichenkoandrey/marshal/releases/latest";

export interface InstallableAsset {
  /** Direct URL to the ZIP asset on github.com. */
  zipUrl: string;
  /** Base64-encoded SHA-512 of the ZIP — same encoding electron-builder uses. */
  sha512: string;
  /** Size in bytes, used for the download progress bar. */
  size: number;
  /** Semver of the release this asset is from. */
  version: string;
}

export interface UpdateCheckResult {
  /** True if `latestVersion` is strictly greater than `currentVersion`. */
  available: boolean;
  /** The version we're running today (semver, no leading `v`). */
  currentVersion: string;
  /** Latest tag from the API, with the `v` stripped. */
  latestVersion: string;
  /** HTML page on github.com — what the user opens when they click "Download". */
  releaseUrl: string;
  /** Direct .dmg asset if the release has one; otherwise null. */
  downloadUrl: string | null;
  /** First ~600 chars of the release body — enough for a notification. */
  releaseNotes: string;
  /**
   * Set when the release carries a `latest-mac.yml` describing a ZIP asset.
   * `null` means we can only point the user at the release page — the in-app
   * installer refuses to run without verifiable SHA-512 metadata.
   */
  installable: InstallableAsset | null;
}

export interface UpdateCheckFailure {
  available: false;
  error: string;
}

export type UpdateCheckOutcome = UpdateCheckResult | UpdateCheckFailure;

export interface UpdateCheckerInit {
  /** Override the version we compare against. Defaults to `app.getVersion()`. */
  currentVersion: string;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export class UpdateChecker {
  private readonly currentVersion: string;
  private readonly fetchImpl: typeof fetch;
  // Conditional-GET caching cuts the request to a 304 on the happy path; we
  // keep the last successful body around so the user still sees a useful
  // answer when the API returns "not modified".
  private cachedEtag: string | null = null;
  private cachedBody: GithubRelease | null = null;
  // Parsed latest-mac.yml from the most recent successful fetch — cached
  // alongside the API body so a 304 still gives us a complete outcome.
  private cachedInstallable: InstallableAsset | null = null;

  constructor(init: UpdateCheckerInit) {
    this.currentVersion = stripLeadingV(init.currentVersion);
    this.fetchImpl = init.fetchImpl ?? globalThis.fetch;
  }

  async check(): Promise<UpdateCheckOutcome> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        // GitHub asks every script to identify itself; otherwise the unauth'd
        // rate limit per IP is brutally tight.
        "User-Agent": "Marshal-Updater"
      };
      if (this.cachedEtag) headers["If-None-Match"] = this.cachedEtag;
      response = await this.fetchImpl(RELEASES_API, { headers });
    } catch (err) {
      return { available: false, error: `Network error: ${(err as Error).message}` };
    }

    if (response.status === 304 && this.cachedBody) {
      return this.outcomeFromCachedRelease(this.cachedBody, this.cachedInstallable);
    }

    if (response.status === 404) {
      // No releases yet — nothing to update to. Distinct from a network
      // failure: surface it as "you're up to date" rather than an error so
      // the UI doesn't yell about a normal pre-1.0 state.
      return {
        available: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        releaseUrl: "",
        downloadUrl: null,
        releaseNotes: "",
        installable: null
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        available: false,
        error: `GitHub API ${response.status}: ${detail.slice(0, 200)}`
      };
    }

    const etag = response.headers.get("etag");
    let release: GithubRelease;
    try {
      release = (await response.json()) as GithubRelease;
    } catch (err) {
      return { available: false, error: `Cannot parse release JSON: ${(err as Error).message}` };
    }

    if (etag) this.cachedEtag = etag;
    this.cachedBody = release;

    // Try to upgrade the outcome with installable metadata. A failure here is
    // not fatal — we still return a valid outcome, just without the ability to
    // self-install.
    const installable = await this.fetchInstallable(release).catch(() => null);
    this.cachedInstallable = installable;

    return this.outcomeFromCachedRelease(release, installable);
  }

  private outcomeFromCachedRelease(
    release: GithubRelease,
    installable: InstallableAsset | null
  ): UpdateCheckOutcome {
    if (release.draft) {
      // Draft releases shouldn't ever satisfy a "check for updates" — they
      // are work in progress on the maintainer side.
      return {
        available: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        releaseUrl: release.html_url,
        downloadUrl: null,
        releaseNotes: "",
        installable: null
      };
    }
    const latestVersion = stripLeadingV(release.tag_name);
    const downloadAsset = release.assets.find((a) => a.name.toLowerCase().endsWith(".dmg")) ?? null;
    return {
      available: isNewer(latestVersion, this.currentVersion),
      currentVersion: this.currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      downloadUrl: downloadAsset?.browser_download_url ?? null,
      releaseNotes: (release.body ?? "").slice(0, 600),
      installable
    };
  }

  private async fetchInstallable(release: GithubRelease): Promise<InstallableAsset | null> {
    const ymlAsset = release.assets.find((a) => a.name === "latest-mac.yml");
    const zipAsset = release.assets.find((a) => a.name.toLowerCase().endsWith(".zip"));
    if (!ymlAsset || !zipAsset) return null;

    const res = await this.fetchImpl(ymlAsset.browser_download_url, {
      headers: { "User-Agent": "Marshal-Updater" }
    });
    if (!res.ok) return null;
    const yml = await res.text();
    const parsed = parseLatestMacYml(yml);
    if (!parsed) return null;

    return {
      zipUrl: zipAsset.browser_download_url,
      sha512: parsed.sha512,
      size: parsed.size,
      version: stripLeadingV(release.tag_name)
    };
  }
}

/** Strip an optional leading `v` from `v1.2.3` so semver compare is uniform. */
export function stripLeadingV(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

/**
 * Strict semver-greater comparison. Major.Minor.Patch, ignoring any pre-release
 * suffix beyond the first numeric triple. Pre-release tags (`1.2.3-beta.1`)
 * still parse — we just compare the numeric prefix, which is enough to keep
 * "1.2.3 is newer than 1.2.2-beta.5" honest without pulling in a semver dep.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseTriple(candidate);
  const b = parseTriple(current);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

function parseTriple(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Hand-rolled parser for the slice of `latest-mac.yml` we care about. The file
 * is generated by electron-builder and follows a fixed shape, so we extract
 * the ZIP entry from the `files:` list without taking a YAML dependency.
 *
 * Shape:
 *   version: 0.1.4
 *   files:
 *     - url: Marshal-0.1.4-arm64.zip
 *       sha512: <base64>
 *       size: 580374993
 *     - url: Marshal-0.1.4-arm64.dmg
 *       sha512: <base64>
 *       size: ...
 *   path: Marshal-0.1.4-arm64.zip
 *   sha512: <base64 of the path file>
 *
 * Returns the ZIP entry's sha512+size, or null if the file is malformed.
 */
export function parseLatestMacYml(text: string): { sha512: string; size: number } | null {
  const lines = text.split(/\r?\n/u);
  let inFiles = false;
  let current: { url?: string; sha512?: string; size?: number } | null = null;
  const entries: Array<{ url: string; sha512: string; size: number }> = [];

  const commit = () => {
    if (current && current.url && current.sha512 && typeof current.size === "number") {
      entries.push({ url: current.url, sha512: current.sha512, size: current.size });
    }
    current = null;
  };

  for (const rawLine of lines) {
    if (/^files\s*:\s*$/u.test(rawLine)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    // A top-level key (no leading whitespace) closes the files block.
    if (/^[^\s-]/u.test(rawLine)) {
      commit();
      inFiles = false;
      continue;
    }
    const dashMatch = rawLine.match(/^\s*-\s*url\s*:\s*(.+?)\s*$/u);
    if (dashMatch) {
      commit();
      current = { url: dashMatch[1] };
      continue;
    }
    if (!current) continue;
    const shaMatch = rawLine.match(/^\s+sha512\s*:\s*(.+?)\s*$/u);
    if (shaMatch) {
      current.sha512 = shaMatch[1];
      continue;
    }
    const sizeMatch = rawLine.match(/^\s+size\s*:\s*(\d+)\s*$/u);
    if (sizeMatch) {
      current.size = Number(sizeMatch[1]);
      continue;
    }
  }
  commit();

  const zip = entries.find((e) => e.url.toLowerCase().endsWith(".zip"));
  if (!zip) return null;
  return { sha512: zip.sha512, size: zip.size };
}
