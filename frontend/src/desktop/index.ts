/**
 * Velxio Desktop SPA hooks - mounted from main.tsx when VITE_DESKTOP is set.
 *
 * Responsibilities since v0.3.0:
 *
 *   1. Decide on first paint whether to mount the welcome / lockout
 *      overlay or let the editor open directly. Driven by
 *      `license_gate_info()` (returns {state, grandfather_days_remaining}).
 *   2. Listen for `velxio://license-required` from the Tauri shell -
 *      fires when the sidecar refuses to start (gate closed) OR
 *      exits with code 78 mid-session. Mounts the LockoutOverlay.
 *   3. Mount the persistent side panels (grace banner + ESP32 prompt).
 *
 * Variant decision (no key paths):
 *
 *   gate.state === 'grandfather'    -> soft welcome with "use anyway for N days"
 *   gate.state === null             -> lockout (no_credential variant)
 *   gate.state === 'valid'|'soft'|'hard' -> normal app, banner handles grace
 *
 * Tampered tokens currently surface via the sidecar exit-78 path
 * because the shell's runtime_state_for_sidecar() maps `Tampered` to
 * None. We could distinguish the two by passing a reason in the event
 * payload (Phase 4 polish).
 */

import { createRoot, type Root } from 'react-dom/client';
import { createElement, createElement as h, Fragment } from 'react';
import { DesktopWelcomePage } from './DesktopWelcomePage';
import { Esp32QemuPrompt } from './Esp32QemuPrompt';
import { Stm32QemuPrompt } from './Stm32QemuPrompt';
import { RaspberryPiQemuPrompt } from './RaspberryPiQemuPrompt';
import { GraceBanner } from './GraceBanner';
import { LockoutOverlay, type LockoutReason } from './LockoutOverlay';
import { UpdateAvailableToast } from './UpdateAvailableToast';
import {
  getGateInfo,
  invoke,
  isTauri,
  listen,
  type GateInfo,
  type ValidationResult,
} from './tauriBridge';
import { installDesktopMenuListener } from './menu';
import { dlog } from './log';
import './desktop.css';

let mounted = false;
let overlayRoot: Root | null = null;
let overlayHost: HTMLElement | null = null;
let sidePanelRoot: Root | null = null;

function unmountOverlay(): void {
  if (overlayRoot) {
    try { overlayRoot.unmount(); } catch { /* noop */ }
    overlayRoot = null;
  }
  if (overlayHost) {
    overlayHost.remove();
    overlayHost = null;
  }
}

function ensureOverlayHost(): HTMLElement {
  if (overlayHost) return overlayHost;
  overlayHost = document.createElement('div');
  overlayHost.id = 'velxio-desktop-overlay-root';
  document.body.appendChild(overlayHost);
  return overlayHost;
}

function mountWelcome(grandfatherDaysRemaining: number | null): void {
  unmountOverlay();
  const host = ensureOverlayHost();
  overlayRoot = createRoot(host);
  overlayRoot.render(
    createElement(DesktopWelcomePage, {
      onAuthorised: () => unmountOverlay(),
      grandfatherDaysRemaining,
    }),
  );
  dlog('mountWelcome', { grandfatherDaysRemaining });
}

function mountLockout(reason: LockoutReason): void {
  unmountOverlay();
  const host = ensureOverlayHost();
  overlayRoot = createRoot(host);
  overlayRoot.render(createElement(LockoutOverlay, { reason }));
  dlog('mountLockout', { reason });
}

function mountSidePanels(): void {
  if (sidePanelRoot) return;
  const host = document.createElement('div');
  host.id = 'velxio-desktop-side-panels';
  document.body.appendChild(host);
  sidePanelRoot = createRoot(host);
  sidePanelRoot.render(
    h(
      Fragment,
      null,
      h(GraceBanner, null),
      h(Esp32QemuPrompt, null),
      h(Stm32QemuPrompt, null),
      h(RaspberryPiQemuPrompt, null),
      // v0.4.0 auto-update toast (~30s after mount). Lives below the
      // grace banner z-index so a lockout / hard-grace doesn't get
      // covered by a "new version available" pitch.
      h(UpdateAvailableToast, null),
    ),
  );
}

/**
 * Decide initial state on first paint. Three outcomes:
 *
 *   1. State is valid / soft_grace / hard_grace -> editor opens, no
 *      overlay (the GraceBanner side panel handles in-app messaging
 *      for soft/hard grace).
 *   2. State is grandfather -> soft welcome with grandfather days
 *      remaining + a "continue without signing in" escape.
 *   3. State is null -> hard lockout (no_credential variant).
 *
 * Tampered tokens currently hit case 3 with a generic reason; we
 * could refine by passing a richer payload from the shell later.
 */
async function evaluateAndMount(gate: GateInfo): Promise<void> {
  switch (gate.state) {
    case 'valid':
    case 'soft_grace':
    case 'hard_grace':
      dlog('evaluateAndMount: state=valid/grace - no overlay', { state: gate.state });
      return;
    case 'grandfather':
      mountWelcome(gate.grandfather_days_remaining);
      return;
    case null:
    default:
      mountLockout('no_credential');
      return;
  }
}

/**
 * Background: validate the cached key. Logs the result for the
 * desktop-debug.log file. Does not gate the editor - the shell
 * already did that at startup. This is mostly an observability hook
 * so we can debug a "valid in shell, invalid in API" mismatch.
 */
async function validateInBackground(): Promise<void> {
  if (!isTauri()) return;
  try {
    const key = await invoke<string | null>('license_get_key');
    if (!key) {
      dlog('validateInBackground: no key (grandfather or anonymous mode)');
      return;
    }
    const result = await invoke<ValidationResult>('license_validate', { key });
    dlog('validateInBackground: validated', {
      valid: result.valid,
      plan: result.plan,
      reason_code: result.reason_code,
    });
  } catch (err) {
    dlog('validateInBackground: failed', { err: String(err) });
  }
}

/**
 * Install the `velxio://license-required` listener. The shell fires
 * this in two cases:
 *
 *   - At startup, when `runtime_state_for_sidecar()` returns None
 *     (no key + grandfather expired, or tampered token). Sidecar
 *     wasn't spawned; we mount the lockout.
 *   - Mid-session, when the sidecar exits with code 78 (the gate
 *     refused mid-run). Same treatment.
 *
 * Payload is either the string "locked" (startup case) or a number
 * (the sidecar's exit code, currently always 78). Either way we
 * mount the no_credential lockout - the user resolves it with
 * sign-in or paste-key, then restartApp() reboots the shell.
 */
function installLicenseRequiredListener(): void {
  void listen('velxio://license-required', (event) => {
    dlog('license-required event', { payload: event.payload });
    mountLockout('no_credential');
  });
}

/**
 * Foreground polling for gate transitions the shell can't push us.
 *
 * The shell's checkin_loop emits `velxio://license-status` every 6h
 * after a network refresh - but the JWT exp is a fixed timestamp, so
 * the soft -> hard -> locked transitions happen purely on wall-clock
 * elapse. The shell doesn't notice them until the next checkin.
 *
 * We poll `license_gate_info` every 10 min while the document is
 * visible. When the state slips from valid/grace into a locked state
 * (gate.state === null), we mount the lockout overlay AND emit a
 * console log for the debug file. Same trigger as the startup
 * evaluation - the user can sign in / paste-key from the same UI.
 *
 * Polling is suspended while the document is hidden (minimised,
 * background tab in dev) so a backgrounded laptop doesn't burn
 * cycles on a fixed-output computation.
 */
let lastGateState: GateInfo['state'] = 'valid';

function installGatePoller(): void {
  const POLL_MS = 10 * 60 * 1000;
  const tick = async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const gate = await getGateInfo();
      // Only react on a TRANSITION INTO a locked state - flicking
      // the overlay on every poll would re-mount during the user
      // typing in the paste field. The lockout-overlay sticks
      // around until restartApp() resolves it.
      if (gate.state === null && lastGateState !== null) {
        dlog('gate transitioned to locked while running', { from: lastGateState });
        mountLockout('expired');
      }
      lastGateState = gate.state;
    } catch (err) {
      dlog('gate poller: getGateInfo failed', { err: String(err) });
    }
  };
  window.setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick();
  });
}

export const mountDesktop = (): void => {
  if (mounted) return;
  mounted = true;
  dlog('mountDesktop - Tauri shell active');

  // Native menubar (Velxio / File / Edit / View / Help) sends events
  // here. Hook the listener before any UI is mounted so the first
  // user click is never dropped.
  void installDesktopMenuListener();

  mountSidePanels();
  installLicenseRequiredListener();
  installGatePoller();

  // First-paint gate evaluation. If the shell is pre-0.3.0 the
  // command isn't registered and getGateInfo() returns the legacy
  // "always valid" stub so the editor opens normally.
  void (async () => {
    const gate = await getGateInfo();
    dlog('initial gate', gate);
    lastGateState = gate.state;
    await evaluateAndMount(gate);
    void validateInBackground();
  })();
};
