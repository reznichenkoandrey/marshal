// Finds the join link of a calendar event. Calendars put it in different
// places (Google's conference field, the location, an HTML description), and
// descriptions are full of other links, so a URL only counts when its host and
// path look like a real meeting room on one of the supported services.

export type MeetingProvider = "meet" | "zoom" | "teams" | "slack";

export type MeetingLink = {
  provider: MeetingProvider;
  url: string;
};

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}\\]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*]+$/;
const REDIRECT_PARAMS = ["q", "url"];

export function classifyMeetingUrl(raw: string): MeetingLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;

  // Google ("google.com/url?q=") and Outlook ("safelinks…?url=") wrap links in
  // redirects; the meeting is the wrapped target.
  if (
    (host === "www.google.com" && pathname === "/url") ||
    host.endsWith(".safelinks.protection.outlook.com")
  ) {
    for (const param of REDIRECT_PARAMS) {
      const target = url.searchParams.get(param);
      if (target) return classifyMeetingUrl(target);
    }
    return null;
  }

  if (host === "meet.google.com" && /^\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}\/?$/i.test(pathname)) {
    return { provider: "meet", url: url.href };
  }
  if (
    (host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoomgov.com" || host.endsWith(".zoomgov.com")) &&
    /^\/(j|w|my|s)\/[^/]+/i.test(pathname)
  ) {
    return { provider: "zoom", url: url.href };
  }
  if (
    (host === "teams.microsoft.com" && pathname.startsWith("/l/meetup-join/")) ||
    (host === "teams.microsoft.com" && pathname.startsWith("/meet/")) ||
    (host === "teams.live.com" && pathname.startsWith("/meet/"))
  ) {
    return { provider: "teams", url: url.href };
  }
  if ((host === "slack.com" || host.endsWith(".slack.com")) && pathname.includes("/huddle/")) {
    return { provider: "slack", url: url.href };
  }
  return null;
}

/**
 * Returns the first meeting link found, checking `sources` in order — callers
 * pass the most specific field first (conference URL, then location, then the
 * description).
 */
export function extractMeetingLink(sources: ReadonlyArray<string | null | undefined>): MeetingLink | null {
  for (const source of sources) {
    if (!source) continue;
    const text = source.replace(/&amp;/gi, "&");
    for (const match of text.matchAll(URL_PATTERN)) {
      const link = classifyMeetingUrl(match[0].replace(TRAILING_PUNCTUATION, ""));
      if (link) return link;
    }
  }
  return null;
}
