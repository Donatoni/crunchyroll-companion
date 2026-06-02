/**
 * Helpers for surviving extension reloads/updates.
 *
 * When the extension is reloaded, content scripts already injected in open tabs
 * keep running but become "orphaned": their `chrome.runtime.id` goes undefined
 * and ANY `chrome.*` call throws "Extension context invalidated" — synchronously,
 * so a `.catch()` on a returned promise does not help. Code in long-lived content
 * scripts must therefore check validity before touching extension APIs.
 */

/** True while this context can still use the extension APIs. */
export function isExtensionContextValid(): boolean {
  // `chrome.runtime.id` is present in a live context and `undefined` once the
  // content script has been orphaned by a reload/update. Reading it can itself
  // throw in some states, so guard with try/catch.
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * Run a chrome API call, swallowing the synchronous "context invalidated" throw
 * (and any rejection) that happens when the extension has been reloaded.
 */
export function safeRuntime<T>(fn: () => T): T | undefined {
  if (!isExtensionContextValid()) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}
