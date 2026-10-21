"use client"

import { Loader2 } from "lucide-react"
import type { ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/** Resumen obligatorio antes de registrar un movimiento (AJU-13). */
export function ConfirmSummaryDialog({
  open,
  title,
  description,
  children,
  busy,
  confirmLabel = "Confirmar",
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  busy: boolean
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <div className="text-sm" data-testid="confirm-summary">
          {children}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Revisar</AlertDialogCancel>
          <Button
            disabled={busy}
            onClick={onConfirm}
            data-testid="confirm-submit"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
