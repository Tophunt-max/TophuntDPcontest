import { useState, useCallback, createContext, useContext, ReactNode } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '@/lib/utils';

// ─── Confirmation Dialog ─────────────────────────────────────────────────────
// A reusable confirm/cancel dialog for destructive admin actions.
// Uses Radix AlertDialog for accessibility (focus trap, escape key, overlay click).
// Usage via hook: const { confirm } = useConfirm();
//   const ok = await confirm({ title: '...', description: '...' });
//   if (ok) doThing();

interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({});
  const [resolve, setResolve] = useState<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((res) => {
      setOptions(opts);
      setResolve(() => res);
      setOpen(true);
    });
  }, []);

  const handleConfirm = () => {
    setOpen(false);
    resolve?.(true);
  };

  const handleCancel = () => {
    setOpen(false);
    resolve?.(false);
  };

  const isDestructive = options.variant === 'destructive';

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <AlertDialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay
            className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          />
          <AlertDialogPrimitive.Content
            className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-2xl"
          >
            <div className="flex flex-col space-y-2 text-center sm:text-left">
              <AlertDialogPrimitive.Title className="text-lg font-semibold">
                {options.title || 'Are you sure?'}
              </AlertDialogPrimitive.Title>
              {options.description && (
                <AlertDialogPrimitive.Description className="text-sm text-muted-foreground">
                  {options.description}
                </AlertDialogPrimitive.Description>
              )}
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
              <AlertDialogPrimitive.Cancel
                onClick={handleCancel}
                className={cn(
                  'inline-flex items-center justify-center rounded-xl text-sm font-medium ring-offset-background transition-colors',
                  'h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground mt-2 sm:mt-0'
                )}
              >
                {options.cancelLabel || 'Cancel'}
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action
                onClick={handleConfirm}
                className={cn(
                  'inline-flex items-center justify-center rounded-xl text-sm font-medium ring-offset-background transition-colors h-10 px-4 py-2',
                  isDestructive
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                )}
              >
                {options.confirmLabel || 'Confirm'}
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </ConfirmContext.Provider>
  );
}
