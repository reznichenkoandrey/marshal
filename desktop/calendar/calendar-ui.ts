// Electron side of the calendar (#269): reminder notifications with Join /
// Join + Record, and the tray's "next meeting" row. Kept out of main.ts so the
// service and the reminder rules stay testable without Electron.

import { app, Notification, powerMonitor, shell, type MenuItemConstructorOptions } from "electron";

import { CalendarService } from "./calendar-service.ts";
import type { CalendarEvent } from "./ical-events.ts";
import type { MeetingLink } from "./meeting-links.ts";
import { resolveAssistantLanguage } from "../assistant/strip.ts";
import { loadSettings } from "../settings-store.ts";
import { actionLabels, reminderText, trayLabel, type Reminder } from "./reminders.ts";

// A Notification that is garbage-collected stops delivering its actions.
const liveNotifications = new Set<Notification>();

export function language() {
  return resolveAssistantLanguage(loadSettings().assistantLanguage, app.getPreferredSystemLanguages());
}

function openMeetingLink(link: MeetingLink): void {
  // classifyMeetingUrl only lets https links to known meeting hosts through.
  void shell.openExternal(link.url);
}

function showReminder(reminder: Reminder, joinAndRecord: () => void): void {
  if (!Notification.isSupported()) return;
  const lang = language();
  const { title, body } = reminderText(reminder, lang, new Date());
  const link = reminder.event.link;
  const labels = actionLabels(lang);
  const actions: Electron.NotificationAction[] = link
    ? reminder.kind === "start"
      ? [{ type: "button", text: labels.join }, { type: "button", text: labels.joinAndRecord }]
      : [{ type: "button", text: labels.join }]
    : [];

  const notification = new Notification({ title, body, actions, silent: reminder.kind !== "start" });
  const release = (): void => {
    liveNotifications.delete(notification);
  };
  notification.on("action", (_event, index) => {
    release();
    if (!link) return;
    openMeetingLink(link);
    if (index === 1) joinAndRecord();
  });
  notification.on("click", () => {
    release();
    if (link) openMeetingLink(link);
  });
  notification.on("close", release);
  liveNotifications.add(notification);
  notification.show();
}

export function createCalendarService(options: {
  dataDir: string;
  joinAndRecord: () => void;
}): CalendarService {
  const service = new CalendarService({ dataDir: options.dataDir });
  service.on("reminder", (reminder) => showReminder(reminder, options.joinAndRecord));
  // Timers do not advance while the Mac sleeps; re-sync on wake so a meeting
  // that starts right after opening the lid still gets its reminder.
  powerMonitor.on("resume", () => void service.refresh());
  return service;
}

export function calendarTrayItem(event: CalendarEvent | null): MenuItemConstructorOptions | null {
  if (!event) return null;
  const link = event.link;
  return {
    label: trayLabel(event, language(), new Date()),
    enabled: link !== null,
    click: () => {
      if (link) openMeetingLink(link);
    }
  };
}
