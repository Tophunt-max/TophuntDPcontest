"use client";

import { cn } from "@/lib/utils";
import { useEffect } from "react";

type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  onConfirm?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  type?: "danger" | "info" | "success";
};

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  onConfirm,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  type = "info",
}: ModalProps) {
  useEffect(() => {
    if (isOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "unset";
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/50 backdrop-blur-sm" 
        onClick={onClose}
      />
      
      {/* Modal Content */}
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-dark border border-stroke dark:border-dark-3 animate-in fade-in zoom-in duration-200">
        <h3 className="text-xl font-bold text-black dark:text-white mb-2">
          {title}
        </h3>
        <div className="text-gray-6 dark:text-gray-4 mb-8">
          {children}
        </div>
        
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-stroke dark:border-dark-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-dark-2 transition-colors"
          >
            {cancelLabel}
          </button>
          
          {onConfirm && (
            <button
              onClick={onConfirm}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors",
                type === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-primary hover:bg-opacity-90"
              )}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
