/**
 * Best-effort human-readable reason out of an unknown throw.
 *
 * `(err as Error).message` is a lie when the thrower isn't an Error —
 * and tauri-plugin-updater rejects with a plain string ("Network Error:
 * ... status: 401"). The cast compiles, `.message` evaluates to
 * undefined, and the dialog reads "Update check failed: undefined",
 * which hid a real 401 for several releases.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}' && json !== 'null') return json;
  } catch {
    // Circular or non-serialisable — String() below still says something.
  }
  return String(err);
}
