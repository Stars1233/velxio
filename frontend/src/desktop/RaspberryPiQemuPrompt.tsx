/**
 * QEMU-Linux runtime download prompt (desktop / Tauri only).
 *
 * Covers every board that boots a Linux guest through the QEMU bridge —
 * Raspberry Pi Zero/1/2/3/4/5 and the overlay-registered kinds such as the
 * UNIHIKER M10 — which is why the copy names the runtime rather than a
 * single board.
 *
 * Why this exists: the desktop bundle ships no `qemu-system-aarch64`, and
 * `qemu_manager` spawns it as a real child process. Until this prompt
 * landed, placing a Pi on the canvas passed the board gate, started, and
 * died with "qemu-system-aarch64 not found in PATH" — proBoardGate's own
 * comment already assumed a prompt like this one was handling it.
 *
 * Scope: this downloads the emulator and qemu-img only. The kernel,
 * initramfs and root filesystem are fetched separately by the Python
 * boot-image provider on first boot, using the license key and CDN base the
 * sidecar passes it, and verified against the sha256 in its own manifest.
 * Hence the two-part size note — the first run costs both.
 */

import { isPiBoardKind } from '../types/board';
import { QemuDownloadPrompt, type QemuRuntimeConfig } from './QemuDownloadPrompt';

const PI_CONFIG: QemuRuntimeConfig = {
  label: 'Raspberry Pi',
  matchKind: (kind) => isPiBoardKind(kind),
  statusCmd: 'pi_qemu_status',
  eligibilityCmd: 'pi_qemu_eligibility',
  installCmd: 'pi_qemu_install',
  progressEvent: 'velxio://pi-qemu-progress',
  // ~26 MB for the emulator archive here, plus ~78 MB of boot images the
  // Python side pulls on the first boot. Quoting only the download this
  // button performs would understate the wait by a factor of four.
  sizeNote: '~105 MB in total',
};

export const RaspberryPiQemuPrompt = () => <QemuDownloadPrompt config={PI_CONFIG} />;
