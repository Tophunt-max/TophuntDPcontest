import React, { useEffect } from 'react';
import { useConfirm } from './ConfirmDialog';
import { setConfirmHandler, type ConfirmRequest } from '@/src/lib/confirmBridge';

/**
 * Mounts the app's confirmation dialog once and exposes it to `confirmBridge`.
 *
 * This is what lets `src/lib/appAlert.ts` — a plain module, callable from a
 * `catch` block or a service with no React context — open a real dialog on web,
 * where `Alert.alert` does nothing.
 *
 * Render once, near the root, inside whatever provides theming.
 */
export const ConfirmHost: React.FC = () => {
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    setConfirmHandler((req: ConfirmRequest) => {
      void confirm({
        title: req.title,
        message: req.message,
        confirmLabel: req.confirmLabel,
        cancelLabel: req.cancelLabel,
        destructive: req.destructive,
      }).then((ok) => {
        // The cancel branch matters: an Alert's cancel button often has real work
        // to do (resuming a paused story, clearing a pending flag), and dropping
        // it would leave the screen in the state it was put into for the dialog.
        if (ok) req.onConfirm?.();
        else req.onCancel?.();
      });
    });
    return () => setConfirmHandler(null);
  }, [confirm]);

  return dialog;
};

export default ConfirmHost;
