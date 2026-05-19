// desktop/uiohook-lifecycle.ts
// Refcounted lifecycle for the process-wide uiohook-napi singleton.
//
// Previously each consumer (clipboard double-⌘C detector, dictation push-to-talk)
// called `uIOhook.start()` and never `uIOhook.stop()`. That left the native
// `hook_thread_proc` worker running through app quit, where it kept posting
// keyboard events through a ThreadSafeFunction into a V8 isolate that was
// being torn down — `napi_fatal_error` → `abort()` (SIGABRT crash on quit).
//
// This module owns the only direct references to `uIOhook.start/stop`. Each
// consumer calls `acquire()` and invokes the returned release fn from its
// own stop(). When the count returns to zero, the worker thread is stopped.
// `shutdownForQuit()` forces a stop regardless of count and must be called
// before V8 begins teardown (i.e. before backendClient.disposeAsync()).
//
// `uIOhook` tolerates start → stop → start cycles, so a consumer that stops
// and later starts again works correctly.
import { uIOhook } from "uiohook-napi";

let refCount = 0;
let started = false;
let shutDown = false;

export type UiohookReleaseFn = () => void;

/**
 * Increments the refcount and starts the native worker on the first acquire.
 * Returns an idempotent release function — call it once when the consumer is
 * done (e.g. in its own stop()).
 */
export function acquireUiohook(): UiohookReleaseFn {
  if (shutDown) {
    // Quit is already in progress. Hand back a no-op release so callers don't
    // need to handle a special case; nothing should be starting new listeners
    // at this point anyway.
    return () => {};
  }
  refCount += 1;
  if (!started) {
    uIOhook.start();
    started = true;
  }
  let released = false;
  return () => {
    if (released || shutDown) return;
    released = true;
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      if (started) {
        uIOhook.stop();
        started = false;
      }
    }
  };
}

/**
 * Force-stop the native worker for app shutdown. Idempotent. Must run before
 * V8 isolate teardown — see file header for why.
 */
export function shutdownUiohookForQuit(): void {
  shutDown = true;
  refCount = 0;
  if (started) {
    uIOhook.stop();
    started = false;
  }
}
