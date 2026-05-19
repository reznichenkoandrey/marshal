// desktop/updater/update-checker.ts
//
// Lightweight "is there a newer release on GitHub?" checker. Lives outside
// the electron-updater (Squirrel.Mac) ecosystem on purpose — that path needs
// signed + notarized .app bundles, which we don't have yet (see #78). This
// service just polls the GitHub Releases API, compares semver tags, and
// hands the caller a URL to open in the browser. The user installs the new
// DMG manually.
//
// When code signing lands, this module stays as the user-facing "Check for
// updates…" surface and electron-updater takes over the background install.

const RELEASES_API = "https://api.github.com/repos/reznichenkoandrey/marshal/releases/latest";

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
      return this.outcomeFromRelease(this.cachedBody);
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
        releaseNotes: ""
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

    return this.outcomeFromRelease(release);
  }

  private outcomeFromRelease(release: GithubRelease): UpdateCheckOutcome {
    if (release.draft) {
      // Draft releases shouldn't ever satisfy a "check for updates" — they
      // are work in progress on the maintainer side.
      return {
        available: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        releaseUrl: release.html_url,
        downloadUrl: null,
        releaseNotes: ""
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
      releaseNotes: (release.body ?? "").slice(0, 600)
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
