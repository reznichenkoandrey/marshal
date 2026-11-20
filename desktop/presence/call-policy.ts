// Pure call-presence policy (#267): when to hold a notification during a call,
// and when to offer recording once per call. No Electron, no timers — the
// caller supplies the facts and performs the side effects.

export type CallState = { onCall: boolean; offered: boolean };

export const INITIAL_CALL_STATE: CallState = { onCall: false, offered: false };

/** Urgent notices (a session waits for the owner) always show; finished results wait for the call to end. */
export function shouldHoldNotification(urgent: boolean, onCall: boolean): boolean {
  return onCall && !urgent;
}

/**
 * Offers recording once when a call starts and nothing records yet. The offer
 * re-arms only after the call ends, so a long call is not nagged about.
 */
export function nextCallState(
  previous: CallState,
  onCall: boolean,
  recording: boolean
): { state: CallState; offer: boolean } {
  if (!onCall) return { state: INITIAL_CALL_STATE, offer: false };
  const offer = !previous.offered && !recording;
  return { state: { onCall: true, offered: previous.offered || offer }, offer };
}

/** Keeps the latest call state; calls `offer` on the edge where a recording offer is due. */
export class CallMonitor {
  private state: CallState = INITIAL_CALL_STATE;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly isRecording: () => boolean,
    private readonly offer: () => void
  ) {}

  async check(): Promise<boolean> {
    const onCall = await this.probe();
    const next = nextCallState(this.state, onCall, this.isRecording());
    this.state = next.state;
    if (next.offer) this.offer();
    return onCall;
  }
}
