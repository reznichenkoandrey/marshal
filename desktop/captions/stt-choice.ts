// desktop/captions/stt-choice.ts
//
// Which speech-to-text backend live captions use (#208, V3 spec §2.1: local
// transcription, no cloud rate limits). Pure: the caller says whether a local
// model is installed, so the rule is tested without touching the disk.

import { resolveBackendName, type BackendName } from "../dictation/whisper-backend.ts";

/**
 * `explicit` is `MARSHAL_CAPTIONS_STT_BACKEND` — set only when the user picked
 * a backend in Settings; `auto` leaves it empty. An explicit pick always
 * wins. Otherwise captions go local whenever a model is installed: with the
 * model kept resident (#218) that is ~0.7 s per utterance, close to Groq's
 * ~0.5 s, without Groq's 20 requests per minute that the live line kept
 * exhausting (#217). Only a machine with no local model follows dictation's
 * backend, as captions always did before.
 */
export function resolveCaptionsSttBackend(
  explicit: string | undefined,
  dictation: string | undefined,
  localAvailable: boolean
): BackendName {
  if (explicit && explicit.trim().length > 0) return resolveBackendName(explicit);
  if (localAvailable) return "whisper-cpp";
  return resolveBackendName(dictation);
}
