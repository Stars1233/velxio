/**
 * STM32 QEMU download prompt (desktop / Tauri only).
 *
 * Thin instantiation of QemuDownloadPrompt for the STM32 runtime
 * (libqemu-arm). Mounted from desktop/index.ts behind VITE_DESKTOP next to
 * Esp32QemuPrompt. Watches for STM32 boards (isStm32BoardKind) and drives the
 * Rust stm32_qemu_status / stm32_qemu_eligibility / stm32_qemu_install
 * commands.
 *
 * Raspberry Pi has no equivalent prompt: its boot images are downloaded by the
 * Python boot-image provider on first Pi boot (the sidecar passes the license
 * key + CDN base URL), so there's nothing for a one-shot Rust download to do.
 */

import { isStm32BoardKind } from '../types/board';
import { QemuDownloadPrompt, type QemuRuntimeConfig } from './QemuDownloadPrompt';

const STM32_CONFIG: QemuRuntimeConfig = {
  label: 'STM32',
  matchKind: (kind) => isStm32BoardKind(kind),
  statusCmd: 'stm32_qemu_status',
  eligibilityCmd: 'stm32_qemu_eligibility',
  installCmd: 'stm32_qemu_install',
  progressEvent: 'velxio://stm32-qemu-progress',
  // Upper bound across platforms: libqemu-arm.so is 54 MB on Linux,
  // the Windows libqemu-arm DLL is 59 MB. '~30 MB' understated both by
  // about half — the kind of surprise that makes someone cancel a
  // download they already started.
  sizeNote: '~60 MB',
};

export const Stm32QemuPrompt = () => <QemuDownloadPrompt config={STM32_CONFIG} />;
