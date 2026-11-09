import { describe, expect, it } from "vitest";

import { classifyMeetingUrl, extractMeetingLink } from "../desktop/calendar/meeting-links.ts";

describe("classifyMeetingUrl", () => {
  it.each([
    ["https://meet.google.com/abc-defg-hij", "meet"],
    ["https://us02web.zoom.us/j/81234567890?pwd=abc", "zoom"],
    ["https://zoom.us/my/personal.room", "zoom"],
    ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0", "teams"],
    ["https://teams.live.com/meet/9876543210", "teams"],
    ["https://app.slack.com/huddle/T0123/C0456", "slack"]
  ])("recognises %s", (url, provider) => {
    expect(classifyMeetingUrl(url)?.provider).toBe(provider);
  });

  it.each([
    "http://meet.google.com/abc-defg-hij",
    "https://meet.google.com/",
    "https://meet.google.com.evil.example/abc-defg-hij",
    "https://zoom.us/pricing",
    "https://teams.microsoft.com/",
    "https://calendar.google.com/calendar/event?eid=abc",
    "javascript:alert(1)"
  ])("rejects %s", (url) => {
    expect(classifyMeetingUrl(url)).toBeNull();
  });

  it("unwraps Google and Outlook redirects", () => {
    expect(
      classifyMeetingUrl("https://www.google.com/url?q=https://zoom.us/j/123&sa=D")
    ).toEqual({ provider: "zoom", url: "https://zoom.us/j/123" });
    expect(
      classifyMeetingUrl(
        "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.live.com%2Fmeet%2F42&data=x"
      )
    ).toEqual({ provider: "teams", url: "https://teams.live.com/meet/42" });
  });
});

describe("extractMeetingLink", () => {
  it("prefers the earlier source and skips unrelated links", () => {
    expect(
      extractMeetingLink([
        null,
        "Room 4",
        "Agenda: https://docs.google.com/document/d/1 then https://zoom.us/j/555."
      ])
    ).toEqual({ provider: "zoom", url: "https://zoom.us/j/555" });
  });

  it("reads links out of HTML descriptions", () => {
    expect(
      extractMeetingLink(['<a href="https://meet.google.com/abc-defg-hij?authuser=0&amp;hs=1">Join</a>'])
    ).toEqual({ provider: "meet", url: "https://meet.google.com/abc-defg-hij?authuser=0&hs=1" });
  });

  it("returns null when nothing is a meeting room", () => {
    expect(extractMeetingLink(["Call me", "https://example.com/meet"])).toBeNull();
  });
});
