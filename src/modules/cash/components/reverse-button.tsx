"use client"

import { Loader2, Undo2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

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
import { Label } from "@/components/ui/label"
import { apiRequest } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

/** Reverso con motivo: crea un contraasiento; el movimiento original se conserva. */
export function ReverseButton({ id, folio }: { id: string; folio: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState("")
  const [key, renewKey] = useIdempotencyKey()

  async function submit() {
    setBusy(true)
    try {
      await apiRequest(`/api/cash-box/movements/${id}/reverse`, {
        method: "POST",
        body: { reason, idempotencyKey: key },
      })
      toast.success("Movimiento revertido")
      renewKey()
      setOpen(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo revertir")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-11 w-full md:h-9 md:w-auto"
        onClick={() => setOpen(true)}
        data-testid="reverse-open"
      >
        <Undo2 />
        Revertir
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !o && !busy && setOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revertir {folio}</AlertDialogTitle>
            <AlertDialogDescription>
              Se registrará un movimiento inverso. El original se conserva y
              solo puede revertirse una vez.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 text-sm">
            <Label htmlFor="reverse-reason">Motivo</Label>
            <textarea
              id="reverse-reason"
              rows={2}
              className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
              onClick={submit}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              Revertir
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
