import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

const LEVELS = ["log", "info", "warn", "error"] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Local time: the owner compares it with the clock, not with UTC. */
export function logStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function logFileName(date: Date): string {
  return `marshal-${logStamp(date).slice(0, 10)}.log`;
}

/**
 * Mirrors main-process console output into `<dir>/marshal-YYYY-MM-DD.log` (0600 in a 0700 dir).
 * An app started from Finder has no terminal, so without this every log line was lost.
 * ponytail: no pruning yet; the owner clears old days by hand until size matters.
 */
export function installFileLog(dir: string, now: () => Date = () => new Date()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let day = "";
  let stream: fs.WriteStream | null = null;
  const write = (level: string, args: unknown[]): void => {
    const date = now();
    const name = logFileName(date);
    if (name !== day) {
      stream?.end();
      day = name;
      stream = fs.createWriteStream(path.join(dir, name), { flags: "a", mode: 0o600 });
      // A full disk or a removed folder must not take logging, let alone the app, down.
      stream.on("error", () => { stream = null; });
    }
    stream?.write(`${logStamp(date)} ${level} ${format(...args)}\n`);
  };
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }
}
