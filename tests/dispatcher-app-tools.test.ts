import { describe, expect, it } from "vitest";

import { appToolRefusal, DISPATCHER_PROMPT, DISPATCHER_SETTINGS, GATED_APP_TOOLS, NO_ROOTS_REFUSAL } from "../desktop/assistant/dispatcher-files.ts";
import type { ClaudeSession } from "../desktop/claude-code/registry.ts";

const roots = ["/htdocs"];
const dispatcherDir = "/data/assistant/dispatcher";
const live: ClaudeSession[] = [
  ["marshal", "/htdocs/marshal", "local_a"],
  ["work", "/axiomvalley/shop", "local_w"],
  ["marshal-dispatcher", dispatcherDir, "local_d"]
].map(([name, cwd, hostSessionId]) => ({
  pid: 1, sessionId: name, name, cwd, status: "idle", waitingFor: null, entrypoint: "claude-desktop",
  socketPath: `/tmp/${name}.sock`, startedAt: 0, statusUpdatedAt: null, hostSessionId
}));
const refusal = (tool: string, input: Record<string, unknown> = {}, allowed: readonly string[] = roots) =>
  appToolRefusal(JSON.stringify({ tool_name: `mcp__ccd_${tool}`, tool_input: input }), live, allowed, dispatcherDir);

describe("Claude app tools by voice (#445)", () => {
  const voiceTools = [
    "session_mgmt__stop_session", "session_mgmt__set_session_title", "session_mgmt__set_session_effort",
    "sidebar__mark_completed", "sidebar__set_pinned", "sidebar__set_unread", "pr__get_status"
  ];

  it.each(voiceTools)("%s reaches a live session under the roots and nothing else", (tool) => {
    expect(GATED_APP_TOOLS.has(`mcp__ccd_${tool}`)).toBe(true);
    expect(refusal(tool, { session_id: "local_a" })).toBeNull();
    expect(refusal(tool, { session_id: "local_w" })).toMatch(/Outside/);
    expect(refusal(tool, { session_id: "local_d" }, [...roots, "/data"])).toMatch(/another/);
    expect(refusal(tool, { session_id: "self" })).toMatch(/another/);
    expect(refusal(tool, {})).toMatch(/another/);
    expect(refusal(tool, { session_id: "local_gone" })).toMatch(/Not a live/);
  });

  it("reads the account's limits but not another session's context", () => {
    expect(refusal("session_mgmt__get_usage")).toBeNull();
    expect(refusal("session_mgmt__get_usage", { session_id: "self" })).toBeNull();
    expect(refusal("session_mgmt__get_usage", { session_id: "local_a" })).toMatch(/own limits/);
  });

  it("refuses every other app tool, so bypass mode cannot skip the gate (#444)", () => {
    for (const tool of [
      "settings__set_setting", "host__clean_up_worktrees", "host__discard_kept_worktree", "directory__change_directory",
      "pr__set_auto_merge", "pr__bind_pr", "session__move_to_cloud", "window__open_session_in", "view__show_pane",
      "session_mgmt__send_message", "session_mgmt__clear_session", "session_mgmt__unarchive_session", "session_mgmt__export_transcript"
    ]) expect(refusal(tool, { session_id: "local_a" })).toMatch(/not allowed/);
    expect(DISPATCHER_SETTINGS.hooks.PreToolUse[0]?.matcher).toBe("mcp__ccd_.*");
    expect(DISPATCHER_SETTINGS.permissions.deny).toEqual(expect.arrayContaining([
      "mcp__ccd_host", "mcp__ccd_settings__set_setting", "mcp__ccd_directory", "mcp__ccd_session_mgmt__send_message"
    ]));
  });

  it("lets the session's own task list UI through", () => {
    expect(refusal("turn__update_plan", { items: [] })).toBeNull();
  });

  it("tells the owner where to allow a folder when none is set", () => {
    expect(refusal("session_mgmt__archive_session", { session_id: "local_a" }, [])).toBe(NO_ROOTS_REFUSAL);
    expect(NO_ROOTS_REFUSAL).toMatch(/Say:.*Settings.*Claude Code/);
    expect(DISPATCHER_PROMPT).toContain("When the refusal contains `Say:`");
  });

  it("asks before stopping or archiving a session", () => {
    expect(DISPATCHER_PROMPT).toMatch(/ask "Зупинити <name>\?"[^\n]*only on a clear yes `stop_session`/);
    expect(DISPATCHER_PROMPT).toMatch(/ask "Архівувати <name>\?"[^\n]*only on a clear yes `archive_session`/);
  });
});
