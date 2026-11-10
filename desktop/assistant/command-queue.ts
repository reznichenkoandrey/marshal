// Voice commands on their way to the dispatcher (#318). The dispatcher's
// Monitor holds one stream open (`./marshal watch`); a command written while
// no stream is open waits here and goes out when one connects. An open stream
// is also the only "the dispatcher listens" signal: no heartbeat, no poller.

export type AssistantCommand = { id: string; at: string; text: string; target?: string };

export interface CommandSink {
  write(line: string): void;
}

export const MAX_QUEUED_COMMANDS = 20;
// Said ten minutes ago and never heard, a command is no longer what the owner wants.
export const QUEUED_COMMAND_TTL_MS = 10 * 60_000;

export class AssistantCommandQueue {
  private readonly sinks = new Set<CommandSink>();
  private queued: AssistantCommand[] = [];
  private lastId = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get listening(): boolean {
    return this.sinks.size > 0;
  }

  /** True when a dispatcher received it now, false when it waits. */
  submit(text: string, target?: string): boolean {
    // Two commands in one millisecond still get distinct ids.
    this.lastId = Math.max(this.now(), this.lastId + 1);
    const command: AssistantCommand = {
      id: String(this.lastId),
      at: new Date(this.now()).toISOString(),
      text,
      ...(target ? { target } : {})
    };
    if (this.deliver(command)) return true;
    this.queued = [...this.queued, command].slice(-MAX_QUEUED_COMMANDS);
    return false;
  }

  connect(sink: CommandSink): void {
    this.sinks.add(sink);
    const cutoff = this.now() - QUEUED_COMMAND_TTL_MS;
    const pending = this.queued.filter((command) => Date.parse(command.at) >= cutoff);
    this.queued = [];
    for (const command of pending) this.deliver(command);
  }

  disconnect(sink: CommandSink): void {
    this.sinks.delete(sink);
  }

  private deliver(command: AssistantCommand): boolean {
    if (this.sinks.size === 0) return false;
    const line = `${JSON.stringify(command)}\n`;
    // One dispatcher is the norm; a second stream (a restarted monitor whose
    // old curl has not died yet) must not make it run the command twice.
    const newest = [...this.sinks].at(-1)!;
    newest.write(line);
    return true;
  }
}
