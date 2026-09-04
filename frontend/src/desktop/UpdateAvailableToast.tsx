/**
 * Update-available toast (v0.4.0+).
 *
 * Renders as a non-intrusive card in the bottom-right corner when the
 * Tauri updater plugin finds a newer release. The user can either
 * install (downloads the full signed installer + restarts) or dismiss
 * for the rest of the session.
 *
 * Why a custom UI instead of `tauri.conf.json::updater.dialog: true`?
 * The native dialog is OS-modal, blocks the editor, and looks dated.
 * A toast respects the user's flow (they can finish the sketch they
 * were typing) but is visible enough that the update doesn't get
 * forgotten.
 *
 * Auto-check fires once on mount with a 60 s delay so it doesn't
 * compete with sidecar startup and the first paint.
 *
 * The Velxio menu's "Check for Updates..." item routes here too, via
 * MANUAL_CHECK_EVENT — it used to run its own check and install without
 * asking. One component owns the flow: ask, show progress, report
 * failures.
 *
 * State machine:
 *   idle          → no update detected, render nothing
 *   available     → render toast with Install / Later
 *   downloading   → render progress bar + "downloading X%"
 *   installing    → render "installing..." (Tauri relauncher takes
 *                   over and the app exits before this state can
 *                   linger in practice)
 *   error         → render error message + Retry button
 *
 * Dismissal persists in sessionStorage so a refresh / re-mount during
 * the same session doesn't spam the user. Closing + reopening the
 * app re-checks.
 */

import { useEffect, useRef, useState } from 'react';
import { isTauri } from './tauriBridge';
import { showMessageDialog } from '../store/useMessageDialogStore';
import { describeError } from './describeError';
import { dlog } from './log';

const DISMISS_KEY = 'vlx-desktop-update-dismissed';
const AUTO_CHECK_DELAY_MS = 60_000;

/**
 * Dispatched by the "Check for Updates" menu item so this component owns
 * the whole update flow. The menu used to call `downloadAndInstall()`
 * itself, which pulled ~100 MB and relaunched the app with no prompt and
 * no progress bar — the opposite of what the automatic check does.
 */
export const MANUAL_CHECK_EVENT = 'velxio://check-updates';

type State =
  | { kind: 'idle' }
  | {
      kind: 'available';
      version: string;
      notes: string | null;
      update: UpdateHandle;
    }
  | {
      kind: 'downloading';
      version: string;
      downloaded: number;
      total: number | null;
    }
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string };

// Minimal shape of what `updater.check()` returns. Matches the
// tauri-plugin-updater 2.x API exposed via `window.__TAURI__.updater`.
interface UpdateHandle {
  version: string;
  date?: string;
  body?: string | null;
  downloadAndInstall: (
    onEvent?: (event: DownloadEvent) => void,
  ) => Promise<void>;
}

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

interface TauriUpdater {
  check?: () => Promise<UpdateHandle | null>;
}

function getUpdater(): TauriUpdater | null {
  if (!isTauri()) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__TAURI__?.updater ?? null;
}

export const UpdateAvailableToast = () => {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const checked = useRef(false);

  // One check routine for both entry points. `manual` only changes how
  // the two quiet outcomes are reported: a background check stays silent
  // (nobody asked), a menu click always answers something — otherwise
  // the button looks broken.
  const runCheck = useRef(async (manual: boolean) => {
    const updater = getUpdater();
    if (!updater?.check) {
      dlog('UpdateToast: tauri-plugin-updater not present in this build');
      if (manual) showMessageDialog('Update plugin not available in this build.');
      return;
    }
    try {
      const result = await updater.check();
      if (!result) {
        dlog('UpdateToast: no update available');
        if (manual) {
          showMessageDialog('Velxio Desktop is up to date.', { kind: 'success' });
        }
        return;
      }
      dlog('UpdateToast: update found', { version: result.version });
      setState({
        kind: 'available',
        version: result.version,
        notes: result.body ?? null,
        update: result,
      });
    } catch (err) {
      dlog('UpdateToast: check() failed', { err: String(err) });
      if (manual) {
        setState({ kind: 'error', message: describeError(err) });
      }
      // Background failures stay silent: we don't want to nag the user
      // about a network check they never asked for.
    }
  });

  // Automatic check, once per session.
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;

    if (sessionStorage.getItem(DISMISS_KEY) === '1') {
      dlog('UpdateToast: dismissed earlier this session, skipping auto-check');
      return;
    }

    const timer = window.setTimeout(
      () => void runCheck.current(false),
      AUTO_CHECK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  // Manual check from the menu. Deliberately ignores the session-dismiss
  // flag: dismissing the toast once shouldn't disable the menu item.
  useEffect(() => {
    const onManual = () => void runCheck.current(true);
    window.addEventListener(MANUAL_CHECK_EVENT, onManual);
    return () => window.removeEventListener(MANUAL_CHECK_EVENT, onManual);
  }, []);

  if (state.kind === 'idle') return null;

  const onInstall = async () => {
    if (state.kind !== 'available') return;
    const update = state.update;
    setState({
      kind: 'downloading',
      version: update.version,
      downloaded: 0,
      total: null,
    });
    try {
      await update.downloadAndInstall((evt) => {
        if (evt.event === 'Started') {
          setState((prev) =>
            prev.kind === 'downloading'
              ? { ...prev, total: evt.data.contentLength ?? null }
              : prev,
          );
        } else if (evt.event === 'Progress') {
          setState((prev) =>
            prev.kind === 'downloading'
              ? { ...prev, downloaded: prev.downloaded + evt.data.chunkLength }
              : prev,
          );
        } else if (evt.event === 'Finished') {
          setState({ kind: 'installing', version: update.version });
        }
      });
      // downloadAndInstall calls relauncher internally - if we got
      // here the app is about to exit. Leave the "installing" card up
      // so the user sees something happening before the window dies.
    } catch (err) {
      dlog('UpdateToast: download/install failed', { err: String(err) });
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setState({ kind: 'idle' });
  };

  const onRetry = () => {
    sessionStorage.removeItem(DISMISS_KEY);
    checked.current = false;
    setState({ kind: 'idle' });
    // Same routine as the menu: the user asked for this one, so a
    // "you're up to date" or a failure both get reported. This used to
    // be a third inline copy of the check whose catch clause did the
    // `err instanceof Error ? ... : String(err)` dance by hand.
    void runCheck.current(true);
  };

  return (
    <div className="vlx-desktop-update-toast" role="status" aria-live="polite">
      {state.kind === 'available' && (
        <>
          <div className="vlx-desktop-update-toast-header">
            <span className="vlx-desktop-update-toast-icon" aria-hidden>
              {'↑'}
            </span>
            <div>
              <div className="vlx-desktop-update-toast-title">
                Update available
              </div>
              <div className="vlx-desktop-update-toast-version">
                Velxio Desktop {state.version}
              </div>
            </div>
          </div>
          {state.notes && (
            <div className="vlx-desktop-update-toast-notes">
              {truncate(state.notes, 200)}
            </div>
          )}
          <div className="vlx-desktop-update-toast-actions">
            <button
              type="button"
              className="vlx-desktop-update-toast-primary"
              onClick={onInstall}
            >
              Install and restart
            </button>
            <button
              type="button"
              className="vlx-desktop-update-toast-secondary"
              onClick={onDismiss}
            >
              Later
            </button>
          </div>
        </>
      )}

      {state.kind === 'downloading' && (
        <>
          <div className="vlx-desktop-update-toast-title">
            Downloading {state.version}...
          </div>
          <div className="vlx-desktop-update-toast-progress">
            <div
              className="vlx-desktop-update-toast-progress-bar"
              style={{
                width: state.total
                  ? `${Math.min(100, Math.round((state.downloaded / state.total) * 100))}%`
                  : '40%',
                animation: state.total
                  ? undefined
                  : 'vlx-indeterminate 1.5s linear infinite',
              }}
            />
          </div>
          <div className="vlx-desktop-update-toast-progress-label">
            {formatProgress(state.downloaded, state.total)}
          </div>
        </>
      )}

      {state.kind === 'installing' && (
        <>
          <div className="vlx-desktop-update-toast-title">
            Installing {state.version}...
          </div>
          <div className="vlx-desktop-update-toast-progress-label">
            Velxio Desktop will restart automatically.
          </div>
        </>
      )}

      {state.kind === 'error' && (
        <>
          <div className="vlx-desktop-update-toast-title">
            Update failed
          </div>
          <div className="vlx-desktop-update-toast-notes">{state.message}</div>
          <div className="vlx-desktop-update-toast-actions">
            <button
              type="button"
              className="vlx-desktop-update-toast-primary"
              onClick={onRetry}
            >
              Retry
            </button>
            <button
              type="button"
              className="vlx-desktop-update-toast-secondary"
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3).trimEnd() + '...';
}

function formatProgress(done: number, total: number | null): string {
  const mb = (b: number) => (b / (1 << 20)).toFixed(1);
  if (total) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    return `${mb(done)} / ${mb(total)} MB (${pct}%)`;
  }
  return `${mb(done)} MB downloaded`;
}
