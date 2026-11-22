// Whose browser is this (#477). The Claude in Chrome extension pairs every
// Chrome on the account wherever it runs, and its isLocal flag is a network
// guess: a Chrome on another Mac in the same Wi-Fi reads as local. So each
// computer keeps its own answer, and a PreToolUse hook refuses every browser
// tool that is not aimed at a browser registered here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__";
export const GUARD_SCRIPT_NAME = "marshal-chrome-guard.sh";
const MAX_REMEMBERED_SESSIONS = 500;
const MAX_NAME_LENGTH = 80;

export type ChromeDevice = { name: string; here: boolean; added?: string; [key: string]: unknown };
export type ChromeDevices = Record<string, ChromeDevice>;
/** null lets the call through; a string refuses it and is what the agent reads. */
export type Refusal = string | null;

/** Shared with the person's other tools that read it, hence not under Marshal's userData. */
export function defaultDevicesPath(): string {
  return path.join(os.homedir(), ".claude", "smart-browser", "chrome-devices.json");
}

function readRegistry(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  // A file we cannot parse is the person's to fix: guessing would open the guard, rewriting would lose it.
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

export function readDevices(file = defaultDevicesPath()): ChromeDevices {
  const devices = readRegistry(file).devices;
  if (typeof devices !== "object" || devices === null || Array.isArray(devices)) return {};
  const known: ChromeDevices = {};
  for (const [id, entry] of Object.entries(devices as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const device = entry as Record<string, unknown>;
    known[id] = { ...device, name: typeof device.name === "string" ? device.name : "", here: device.here === true };
  }
  return known;
}

function writeDevices(file: string, devices: ChromeDevices): void {
  const registry = { ...readRegistry(file), devices };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.marshal-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isDeviceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id);
}

/** A name arrives from the agent and ends up in a dialog and a menu: one line, bounded. */
export function cleanDeviceName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

function describe(devices: ChromeDevices): string {
  return Object.entries(devices).map(([id, device]) => `${id} (${device.name})`).join(", ");
}

type HookCall = { tool: string; sessionId: string; deviceId: string };

function parseCall(raw: string): HookCall | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { tool_name: tool, session_id: sessionId, tool_input: input } = event as Record<string, unknown>;
  if (typeof tool !== "string") return null;
  const deviceId = typeof input === "object" && input !== null ? (input as Record<string, unknown>).deviceId : "";
  return {
    tool,
    sessionId: typeof sessionId === "string" ? sessionId : "",
    deviceId: typeof deviceId === "string" ? deviceId.trim() : ""
  };
}

export class ChromeGuard {
  // Session id -> the browser it picked. In memory: after a restart a session selects again.
  private readonly selected = new Map<string, string>();

  constructor(
    private readonly file = defaultDevicesPath(),
    /** How the agent proposes a browser, e.g. `/bin/sh '<script>' add`. */
    private readonly proposeCommand = ""
  ) {}

  devices(): ChromeDevices {
    return readDevices(this.file);
  }

  /** The person's answer, from the dialog or the tray. */
  setDevice(id: string, name: string, here: boolean): void {
    const devices = this.devices();
    devices[id] = { ...devices[id], name: name || devices[id]?.name || "", here, added: devices[id]?.added ?? new Date().toISOString().slice(0, 19) };
    writeDevices(this.file, devices);
  }

  /**
   * The rules, and why each one:
   *   list_connected_browsers  always: it is how the agent finds out what exists
   *   select_browser           only a deviceId registered as this computer's
   *   switch_browser           never: it pops a Connect prompt on EVERY paired Chrome
   *   everything else          only after a permitted select_browser in this session:
   *                            the extension's default is whichever browser was used last, on any machine
   * Fails closed: what it cannot read or understand it refuses.
   */
  judge(raw: string): Refusal {
    const call = parseCall(raw);
    if (!call) return "the hook payload is not a tool call, so there is nothing to allow.";
    if (!call.tool.startsWith(CHROME_TOOL_PREFIX)) return null;
    const action = call.tool.slice(CHROME_TOOL_PREFIX.length);
    if (action === "list_connected_browsers") return null;

    let devices: ChromeDevices;
    try {
      devices = this.devices();
    } catch (err) {
      return `the browser registry cannot be read (${err instanceof Error ? err.message : String(err)}), so no browser is known to be this computer's. Tell the user.`;
    }
    const here = Object.fromEntries(Object.entries(devices).filter(([, device]) => device.here));
    const ours = Object.keys(here).length > 0
      ? `Registered as this computer's: ${describe(here)}.`
      : "No browser is registered as this computer's yet.";
    const propose = (id: string) => `${this.proposeCommand || "marshal-chrome-guard.sh add"} ${id} "<the browser's name>"`;

    if (action === "switch_browser") {
      return "switch_browser sends a Connect prompt to EVERY paired Chrome, including the ones on other computers. "
        + `Use list_connected_browsers, then select_browser with a deviceId registered on this computer. ${ours}`;
    }
    if (action === "select_browser") {
      const device = devices[call.deviceId];
      if (device?.here) {
        if (call.sessionId) this.remember(call.sessionId, call.deviceId);
        return null;
      }
      if (device) {
        return `${call.deviceId} is "${device.name}", registered as NOT this computer's browser, and never driven from here. ${ours}`;
      }
      if (!isDeviceId(call.deviceId)) return `select_browser needs a deviceId from list_connected_browsers. ${ours}`;
      return `${call.deviceId} is not registered on this computer. Do not guess: the extension's isLocal flag is a network guess, `
        + "and a Chrome on another computer in the same Wi-Fi shows as local. Ask the user which browser this is, then propose it with Bash:\n"
        + `  ${propose(call.deviceId)}\n`
        + `Marshal asks the person to confirm and records their answer; then call select_browser again. ${ours}`;
    }
    const chosen = this.selected.get(call.sessionId);
    if (chosen !== undefined && here[chosen]) return null;
    return "no browser is selected in this session, and the extension's default is whichever Chrome was used last, on any computer. "
      + `Call list_connected_browsers, then select_browser with a deviceId registered on this computer. ${ours}`;
  }

  private remember(sessionId: string, deviceId: string): void {
    this.selected.delete(sessionId);
    this.selected.set(sessionId, deviceId);
    if (this.selected.size > MAX_REMEMBERED_SESSIONS) this.selected.delete(this.selected.keys().next().value as string);
  }
}

export type GuardMenuItem = {
  label?: string;
  type?: "checkbox" | "separator";
  checked?: boolean;
  enabled?: boolean;
  click?: () => void;
};

/** The tray submenu: the switch, then every registered browser with "on this Mac" as its checkbox. */
export function guardMenuItems(
  installed: boolean,
  devices: ChromeDevices,
  text: { on: string; browsers: string; none: string },
  act: { setInstalled(installed: boolean): void; setHere(deviceId: string, here: boolean): void }
): GuardMenuItem[] {
  const entries = Object.entries(devices);
  return [
    { label: text.on, type: "checkbox", checked: installed, click: () => act.setInstalled(!installed) },
    { type: "separator" },
    { label: entries.length > 0 ? text.browsers : text.none, enabled: false },
    ...entries.map(([id, device]): GuardMenuItem => ({
      label: `${device.name || id} · ${id.slice(0, 8)}`,
      type: "checkbox",
      checked: device.here,
      click: () => act.setHere(id, !device.here)
    }))
  ];
}

/**
 * The hook itself and the `add` command share one script. Anything but the
 * word "allow" from a running Marshal is a refusal (exit 2): a guard that lets
 * calls through while nobody can answer is not one.
 */
export function buildGuardScript(hookDir: string, guardPath: string, devicePath: string): string {
  const dir = `'${hookDir.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    "# Marshal: PreToolUse guard for Claude in Chrome (#477). No answer from Marshal refuses the call.",
    `dir=${dir}`,
    "if ! [ -r \"$dir/port\" ] || ! [ -r \"$dir/auth-header\" ]; then",
    "  echo 'chrome-guard: Marshal is not running, so nothing can say whose browser this is. Start Marshal and try again.' >&2",
    "  exit 2",
    "fi",
    "base=\"http://127.0.0.1:$(cat \"$dir/port\")\"",
    "if [ \"$1\" = add ]; then",
    "  if [ -z \"$2\" ] || [ -z \"$3\" ]; then echo 'usage: add <deviceId> <name>' >&2; exit 1; fi",
    "  # The person answers a dialog: give them time.",
    `  curl -s --fail-with-body -m 130 -H @"$dir/auth-header" --data-urlencode "id=$2" --data-urlencode "name=$3" "$base${devicePath}"`,
    "  exit $?",
    "fi",
    `verdict=$(curl -s --fail-with-body -m 4 -H @"$dir/auth-header" -H 'Content-Type: application/json' --data-binary @- "$base${guardPath}") || { echo "chrome-guard: \${verdict:-Marshal did not answer.}" >&2; exit 2; }`,
    "[ \"$verdict\" = allow ] && exit 0",
    "echo \"chrome-guard: $verdict\" >&2",
    "exit 2",
    ""
  ].join("\n");
}
