"use client"

import { Loader2 } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { formatMXN } from "@/modules/cash/components/format"

const textareaClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"

/**
 * Verificación MANUAL de una transferencia (BAN): el usuario revisa el
 * ingreso en la banca y confirma o rechaza. El servidor registra quién y
 * cuándo; confirmar dos veces no contabiliza dos veces.
 */
export function BankTransferActions({
  id,
  declaredAmount,
  bankReference,
}: {
  id: string
  declaredAmount: string
  bankReference: string | null
}) {
  const router = useRouter()
  const [mode, setMode] = useState<"confirm" | "reject" | null>(null)
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)
  const [amount, setAmount] = useState(declaredAmount)
  const [reference, setReference] = useState(bankReference ?? "")
  const [notes, setNotes] = useState("")
  const [reason, setReason] = useState("")
  const [duplicateWarning, setDuplicateWarning] = useState(false)

  function close() {
    if (busy) return
    setMode(null)
    setDuplicateWarning(false)
  }

  async function submit() {
    setBusy(true)
    try {
      if (mode === "confirm") {
        await apiRequest(`/api/cash-box/bank-transfers/${id}/confirm`, {
          method: "POST",
          body: {
            verifiedInBank: verified,
            confirmedAmount: amount.trim() || undefined,
            bankReference: reference.trim() || undefined,
            notes: notes.trim() || undefined,
            acknowledgePossibleDuplicate: duplicateWarning || undefined,
          },
        })
        toast.success("Transferencia confirmada")
      } else {
        await apiRequest(`/api/cash-box/bank-transfers/${id}/reject`, {
          method: "POST",
          body: { reason },
        })
        toast.success("Transferencia rechazada")
      }
      setMode(null)
      router.refresh()
    } catch (e) {
      if (
        e instanceof ApiClientError &&
        e.code === "CONFLICT" &&
        mode === "confirm"
      ) {
        setDuplicateWarning(true)
      }
      toast.error(
        e instanceof Error ? e.message : "No se pudo completar la operación"
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        className="h-11 md:h-9"
        onClick={() => setMode("confirm")}
        data-testid="transfer-confirm"
      >
        Confirmar
      </Button>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => setMode("reject")}
        data-testid="transfer-reject"
      >
        Rechazar
      </Button>

      <AlertDialog open={mode !== null} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {mode === "confirm"
                ? "Confirmar transferencia"
                : "Rechazar transferencia"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Importe declarado: {formatMXN(declaredAmount)}.{" "}
              {mode === "confirm"
                ? "Solo confirma después de ver el ingreso en la cuenta bancaria."
                : "Rechazar no registra ninguna entrada de dinero."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {mode === "confirm" ? (
            <div className="space-y-3 text-sm">
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                  data-testid="transfer-verified"
                />
                Verifiqué en la banca que el dinero ingresó a la cuenta.
              </label>
              <div className="space-y-1">
                <Label htmlFor="confirmed-amount">Importe acreditado</Label>
                <Input
                  id="confirmed-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bank-reference">
                  Referencia / clave de rastreo
                </Label>
                <Input
                  id="bank-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="verify-notes">
                  Notas (obligatorias si el importe difiere)
                </Label>
                <textarea
                  id="verify-notes"
                  rows={2}
                  className={textareaClass}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              {duplicateWarning ? (
                <p
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2"
                  data-testid="duplicate-warning"
                >
                  Ya existe una transferencia confirmada con la misma referencia
                  e importe. Si verificaste que son ingresos distintos, vuelve a
                  pulsar «Confirmar» para registrarla de todos modos.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1 text-sm">
              <Label htmlFor="reject-reason">Motivo del rechazo</Label>
              <textarea
                id="reject-reason"
                rows={2}
                className={textareaClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="reject-reason"
              />
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <Button
              disabled={
                busy ||
                (mode === "confirm" ? !verified : reason.trim().length < 3)
              }
              variant={mode === "reject" ? "destructive" : "default"}
              onClick={submit}
              data-testid="transfer-submit"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {mode === "confirm" ? "Confirmar" : "Rechazar"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
