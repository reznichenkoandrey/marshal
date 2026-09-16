// desktop/translator/backends/errors.ts
//
// One typed error the translator service can act on. A rejected credential is
// not like other failures: when the backend was chosen automatically (see
// factory.ts), the right response is to fall back to a provider that does
// work rather than to hand the user a 401. Matching on message text would
// break the first time a provider rewords its errors, so the status travels
// with the error instead. See #160.

/** Statuses that mean "this credential will not work, retrying won't help". */
export function isAuthStatus(status: unknown): boolean {
  return status === 401 || status === 403;
}

export class TranslatorAuthError extends Error {
  readonly status: number;
  /** Which backend's credential was rejected — used in the user-facing notice. */
  readonly backendId: string;

  constructor(backendId: string, status: number, detail: string) {
    super(`${backendId} rejected the credential (HTTP ${status}): ${detail}`);
    this.name = "TranslatorAuthError";
    this.status = status;
    this.backendId = backendId;
  }
}

/**
 * True for a TranslatorAuthError, and also for anything carrying an auth
 * status — so an SDK error that slipped through unwrapped is still recognised.
 */
export function isTranslatorAuthError(err: unknown): boolean {
  if (err instanceof TranslatorAuthError) return true;
  if (!err || typeof err !== "object") return false;
  return isAuthStatus((err as { status?: unknown }).status);
}
