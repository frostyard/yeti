import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Dialog({ open, onOpenChange, title, children, trigger }: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  children: ReactNode;
  trigger?: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-lg)] border border-border bg-raised p-5 shadow-[var(--shadow-pop)]">
          <div className="mb-3 flex items-center justify-between">
            <RadixDialog.Title className="text-[15px] font-semibold text-text">{title}</RadixDialog.Title>
            <RadixDialog.Close className="rounded p-1 text-muted hover:text-text" aria-label="Close">
              <X size={16} />
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
