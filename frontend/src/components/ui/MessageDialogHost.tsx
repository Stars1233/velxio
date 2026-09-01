/**
 * MessageDialogHost — renders the global message dialog driven by
 * useMessageDialogStore (the replacement for window.alert()).
 *
 * Mounted once in App.tsx so it is available on every page, in web and
 * desktop builds, and to the pro overlay. Styling follows the dark modal
 * convention used by FlashModal / ShareModal.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMessageDialogStore, type MessageDialogKind } from '../../store/useMessageDialogStore';

const ACCENTS: Record<MessageDialogKind, { bg: string; fg: string; icon: string }> = {
  info: { bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-fg)', icon: 'ℹ' },
  success: { bg: 'var(--color-feedback-success-soft)', fg: 'var(--color-feedback-success)', icon: '✓' },
  error: { bg: 'var(--color-feedback-error-soft)', fg: 'var(--color-feedback-error)', icon: '⚠' },
};

export const MessageDialogHost = () => {
  const { open, mode, kind, title, message, confirmLabel, cancelLabel, danger, close } =
    useMessageDialogStore();
  const okRef = useRef<HTMLButtonElement | null>(null);
  const isConfirm = mode === 'confirm';

  useEffect(() => {
    if (!open) return;
    // Focus the primary button so Enter confirms/dismisses, matching the
    // native alert()/confirm() flow.
    okRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open) return null;

  const accent = ACCENTS[kind];

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => close(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        zIndex: 9700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
          background: 'var(--color-accent-soft)',
          color: 'var(--wb-13)',
          border: '1px solid var(--wb-5)',
          borderRadius: 8,
          padding: 20,
          boxShadow: '0 12px 36px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        {title && (
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
        )}

        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            padding: 12,
            background: accent.bg,
            color: accent.fg,
            borderRadius: 4,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <span aria-hidden style={{ fontSize: 15, lineHeight: '19px' }}>
            {accent.icon}
          </span>
          <span style={{ whiteSpace: 'pre-wrap', overflowY: 'auto' }}>{message}</span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {isConfirm && (
            <button
              type="button"
              onClick={() => close(false)}
              style={{
                padding: '7px 20px',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--wb-13)',
                background: 'var(--color-accent-soft)',
                border: '1px solid var(--wb-7)',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            onClick={() => close(true)}
            style={{
              padding: '7px 20px',
              fontSize: 13,
              fontWeight: 600,
              color: 'white',
              background: danger
                ? 'linear-gradient(135deg, #d64545 0%, #a12727 100%)'
                : 'linear-gradient(135deg, #007acc 0%, #005ea1 100%)',
              border: danger ? '1px solid #a12727' : '1px solid #005ea1',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {isConfirm ? confirmLabel : 'OK'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
