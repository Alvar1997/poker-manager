"use client"

import { Save } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { apiRequest } from "@/lib/api-client"
import { ConfirmSummaryDialog } from "@/modules/inventory/components/confirm-summary-dialog"
import {
  denominationTitle,
  formatChips,
  formatNominal,
} from "@/modules/inventory/components/format"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import {
  parseQuantity,
  QuantityInput,
} from "@/modules/inventory/components/quantity-input"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

type Denomination = {
  denominationId: string
  value: string
  color: string | null
  name: string | null
}

/**
 * Inventario inicial: TODAS las denominaciones activas (0 si no hay).
 * La vista previa es orientativa; el servidor recalcula y valida.
 */
export function InitialStockForm({
  chipSetId,
  chipSetName,
  denominations,
}: {
  chipSetId: string
  chipSetName: string
  denominations: Denomination[]
}) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key, renewKey] = useIdempotencyKey()

  const parsed = denominations.map((d) => ({
    ...d,
    quantity: parseQuantity(values[d.denominationId] ?? ""),
  }))
  const missing = parsed.filter((d) => d.quantity === null).length
  const invalid = parsed.some((d) => Number.isNaN(d.quantity))
  const previewTotal = parsed.reduce(
    (acc, d) => acc + (d.quantity ?? 0) * Number(d.value),
    0
  )

  function review() {
    setError(null)
    if (invalid)
      return setError("Usa solo números enteros (sin decimales ni signos).")
    if (missing > 0)
      return setError(
        `Captura todas las denominaciones (escribe 0 si no hay). Faltan ${missing}.`
      )
    setOpen(true)
  }

  async function confirm() {
    setBusy(true)
    try {
      await apiRequest(`/api/chip-inventory/initial-stock`, {
        method: "POST",
        body: {
          chipSetId,
          lines: parsed.map((d) => ({
            denominationId: d.denominationId,
            quantity: d.quantity,
          })),
          idempotencyKey: key,
        },
      })
      toast.success("Inventario inicial registrado")
      renewKey()
      router.push(`${INVENTORY_BASE}/${chipSetId}`)
      router.refresh()
    } catch (e) {
      setOpen(false)
      setError(e instanceof Error ? e.message : "No se pudo registrar")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {denominations.map((d) => (
          <li
            key={d.denominationId}
            className="flex items-center justify-between gap-3"
          >
            <Label htmlFor={`q-${d.denominationId}`} className="text-sm">
              {denominationTitle(d)}
            </Label>
            <QuantityInput
              id={`q-${d.denominationId}`}
              className="w-28"
              placeholder="0"
              value={values[d.denominationId] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [d.denominationId]: e.target.value }))
              }
              aria-label={`Cantidad de ${denominationTitle(d)}`}
            />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">
        Valor nominal estimado: {formatNominal(previewTotal)}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button className="h-11 w-full md:h-9 md:w-auto" onClick={review}>
        <Save />
        Revisar y confirmar
      </Button>

      <ConfirmSummaryDialog
        open={open}
        busy={busy}
        title={`Inventario inicial · ${chipSetName}`}
        description="Se registra una sola vez y no se puede editar; las correcciones posteriores serán ajustes."
        confirmLabel="Confirmar inventario inicial"
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      >
        <ul className="divide-y">
          {parsed.map((d) => (
            <li key={d.denominationId} className="flex justify-between py-1.5">
              <span>{denominationTitle(d)}</span>
              <span className="tabular-nums">
                {formatChips(d.quantity ?? 0)}
              </span>
            </li>
          ))}
        </ul>
        <p className="pt-2 font-medium">
          Total nominal estimado: {formatNominal(previewTotal)}
        </p>
      </ConfirmSummaryDialog>
    </div>
  )
}
