import type { MarshalSettings } from "../settings-store.ts";

type MediaAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type PermissionCheckSnapshot = {
  platform: NodeJS.Platform;
  currentVersion: string;
  lastSeenVersion: string;
  microphoneStatus: MediaAccessStatus;
  screenStatus: MediaAccessStatus;
  accessibilityTrusted: boolean;
};

export type MissingPermissionId = "microphone" | "accessibility" | "screen-recording";

export type MissingPermission = {
  id: MissingPermissionId;
  label: string;
  status: string;
  action: string;
  url: string;
};

export type PermissionCheckDecision = {
  shouldPrompt: boolean;
  missing: MissingPermission[];
};

export type PostInstallPermissionCheckDeps = {
  currentVersion: string;
  loadSettings: () => MarshalSettings;
  saveSettings: (settings: Partial<MarshalSettings>) => MarshalSettings;
  queryPermissions: () => Omit<PermissionCheckSnapshot, "currentVersion" | "lastSeenVersion">;
  showMessageBox: (options: {
    type: "info";
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
  }) => Promise<{ response: number }>;
  openExternal: (url: string) => Promise<unknown>;
};

const PERMISSION_DEFS: Record<MissingPermissionId, Omit<MissingPermission, "status">> = {
  microphone: {
    id: "microphone",
    label: "Microphone",
    action: "System Settings -> Privacy & Security -> Microphone",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
  },
  accessibility: {
    id: "accessibility",
    label: "Accessibility",
    action: "System Settings -> Privacy & Security -> Accessibility",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  },
  "screen-recording": {
    id: "screen-recording",
    label: "Screen Recording",
    action: "System Settings -> Privacy & Security -> Screen Recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  }
};

export function evaluatePostInstallPermissionCheck(
  snapshot: PermissionCheckSnapshot
): PermissionCheckDecision {
  if (snapshot.platform !== "darwin") {
    return { shouldPrompt: false, missing: [] };
  }
  if (!snapshot.currentVersion || snapshot.currentVersion === snapshot.lastSeenVersion) {
    return { shouldPrompt: false, missing: [] };
  }

  const missing: MissingPermission[] = [];
  if (snapshot.microphoneStatus !== "granted") {
    missing.push({ ...PERMISSION_DEFS.microphone, status: snapshot.microphoneStatus });
  }
  if (!snapshot.accessibilityTrusted) {
    missing.push({ ...PERMISSION_DEFS.accessibility, status: "denied" });
  }
  if (snapshot.screenStatus !== "granted") {
    missing.push({ ...PERMISSION_DEFS["screen-recording"], status: snapshot.screenStatus });
  }

  return { shouldPrompt: missing.length > 0, missing };
}

export async function runPostInstallPermissionCheck(
  deps: PostInstallPermissionCheckDeps
): Promise<void> {
  const settings = deps.loadSettings();
  const decision = evaluatePostInstallPermissionCheck({
    ...deps.queryPermissions(),
    currentVersion: deps.currentVersion,
    lastSeenVersion: settings.lastSeenVersion
  });

  if (!decision.shouldPrompt) {
    if (settings.lastSeenVersion !== deps.currentVersion) {
      deps.saveSettings({ lastSeenVersion: deps.currentVersion });
    }
    return;
  }

  let missing = decision.missing;
  while (true) {
    const buttons = [
      ...missing.map((permission) => `Open ${permission.label}`),
      "Re-test",
      "Later"
    ];
    const retestIndex = missing.length;
    const laterIndex = missing.length + 1;

    const { response } = await deps.showMessageBox({
      type: "info",
      title: "Marshal permissions may need attention",
      message:
        "Marshal was updated or rebuilt. macOS may require privacy permissions again " +
        "before dictation, push-to-talk, and capture work correctly.",
      detail: buildPermissionDetail(missing),
      buttons,
      defaultId: 0,
      cancelId: laterIndex
    });

    if (response >= 0 && response < missing.length) {
      await deps.openExternal(missing[response].url);
      deps.saveSettings({ lastSeenVersion: deps.currentVersion });
      return;
    }

    if (response === retestIndex) {
      const next = evaluatePostInstallPermissionCheck({
        ...deps.queryPermissions(),
        currentVersion: deps.currentVersion,
        lastSeenVersion: ""
      });
      if (!next.shouldPrompt) {
        await deps.showMessageBox({
          type: "info",
          title: "Marshal permissions are ready",
          message: "Microphone, Accessibility, and Screen Recording permissions look ready.",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0
        });
        deps.saveSettings({ lastSeenVersion: deps.currentVersion });
        return;
      }
      missing = next.missing;
      continue;
    }

    deps.saveSettings({ lastSeenVersion: deps.currentVersion });
    return;
  }
}

function buildPermissionDetail(missing: MissingPermission[]): string {
  const lines = missing.map((permission) =>
    `- ${permission.label}: ${permission.status}. Open ${permission.action}.`
  );
  lines.push(
    "",
    "Input Monitoring has no Electron status API. If push-to-talk still does not react after Accessibility is granted, also check System Settings -> Privacy & Security -> Input Monitoring."
  );
  return lines.join("\n");
}
