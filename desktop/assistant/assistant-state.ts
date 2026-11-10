// What the assistant home shows in its centre (#284). Main owns the inputs
// (dictation, speech, sessions) and derives one state from them; the window
// only draws it. Pure, so the precedence is testable without Electron.

export const ASSISTANT_STATES = ["idle", "listening", "thinking", "speaking", "working", "waiting", "offline"] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

export type AssistantInputs = {
  dictating: boolean;
  transcribing: boolean;
  speaking: boolean;
  busySessions: number;
  waitingSessions: number;
  // No speech-to-text available: nothing the user says can be heard.
  offline: boolean;
};

export const IDLE_INPUTS: AssistantInputs = {
  dictating: false,
  transcribing: false,
  speaking: false,
  busySessions: 0,
  waitingSessions: 0,
  offline: false
};

/**
 * What the user is doing right now wins over what sessions are doing: while
 * they speak the visual must react to them, not to a busy session elsewhere.
 * A waiting session outranks a busy one because only it needs the user.
 */
export function deriveAssistantState(inputs: AssistantInputs): AssistantState {
  if (inputs.dictating) return "listening";
  if (inputs.transcribing) return "thinking";
  if (inputs.speaking) return "speaking";
  if (inputs.waitingSessions > 0) return "waiting";
  if (inputs.busySessions > 0) return "working";
  if (inputs.offline) return "offline";
  return "idle";
}
