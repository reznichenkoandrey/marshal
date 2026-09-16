// desktop/translator/backends/errors.ts
//
// One typed error for "this backend cannot serve requests". Two different
// causes land here, and both have the same right answer when the backend was
// chosen automatically (see factory.ts): stop using it and fall back to one
// that works.
//
//   auth  — 401/403, the credential is refused (#160: an expired Groq key)
//   model — 404 model_not_found, the configured model does not exist on this
//           account (#162: our default was a decommissioned llama)
//
// Matching on message text would break the first time a provider rewords its
// errors, so the status and the reason travel with the error instead.

export type BackendUnusableReason = "auth" | "model";

/** 401/403 — the credential itself is refused; retrying cannot help. */
export function isAuthStatus(status: unknown): boolean {
  return status === 401 || status === 403;
}

/**
 * A 404 from a chat completion means the model, not the route — the route is
 * the same one that answers for every other model. Groq marks it
 * `model_not_found`; the body check keeps a genuinely missing endpoint (a
 * mistyped MARSHAL_API_BASE) out of this bucket, because that one is worth
 * surfacing rather than papering over.
 */
export function isModelNotFound(status: unknown, body: string): boolean {
  return status === 404 && /model_not_found|does not exist/iu.test(body);
}

export class TranslatorBackendUnusableError extends Error {
  readonly status: number;
  readonly reason: BackendUnusableReason;
  /** Which backend could not serve the request — used in the notice. */
  readonly backendId: string;
  /** For `model`: the model that was asked for, so the notice can name it. */
  readonly model?: string;

  constructor(
    backendId: string,
    status: number,
    reason: BackendUnusableReason,
    detail: string,
    model?: string
  ) {
    super(
      reason === "auth"
        ? `${backendId} rejected the credential (HTTP ${status}): ${detail}`
        : `${backendId} has no model "${model ?? "?"}" (HTTP ${status}): ${detail}`
    );
    this.name = "TranslatorBackendUnusableError";
    this.status = status;
    this.reason = reason;
    this.backendId = backendId;
    if (model !== undefined) this.model = model;
  }
}

/**
 * True for our typed error, and also for anything carrying an auth status —
 * so an SDK error that slipped through unwrapped is still recognised.
 */
export function isBackendUnusableError(err: unknown): boolean {
  if (err instanceof TranslatorBackendUnusableError) return true;
  if (!err || typeof err !== "object") return false;
  return isAuthStatus((err as { status?: unknown }).status);
}
