"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/shared/native-select"
import { SharedInventoryNote } from "@/modules/inventory/components/shared-inventory-note"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { apiRequest } from "@/lib/api-client"
import { ConfirmSummaryDialog } from "@/modules/inventory/components/confirm-summary-dialog"
import {
  denominationTitle,
  formatChips,
  formatNominal,
} from "@/modules/inventory/components/format"
import {
  parseQuantity,
  QuantityInput,
} from "@/modules/inventory/components/quantity-input"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  WITHDRAWAL_CATEGORIES,
  WITHDRAWAL_CATEGORY_LABEL,
} from "@/modules/inventory/inventory.schemas"

export type OperationChipSet = {
  id: string
  name: string
  containerLabel: string
  denominations: {
    denominationId: string
    value: string
    color: string | null
    name: string | null
    isActive: boolean
    available: number
    custody: number
  }[]
}

const schema = z.object({
  chipSetId: z.string().min(1, "Selecciona el inventario"),
  category: z.string(),
  reason: z
    .string()
    .trim()
    .min(3, "El motivo es obligatorio (mínimo 3 caracteres)")
    .max(300),
  notes: z.string().max(500),
  quantities: z.record(z.string(), z.string()),
})
type Values = z.infer<typeof schema>

/**
 * Entrada (fichas nuevas) o baja definitiva (daño, pérdida, retiro) de una
 * o varias denominaciones en una sola operación atómica.
 */
export function StockOperationForm({
  mode,
  chipSets,
}: {
  mode: "entry" | "withdrawal"
  chipSets: OperationChipSet[]
}) {
  const router = useRouter()
  const [key, renewKey] = useIdempotencyKey()
  const [review, setReview] = useState<null | {
    lines: { d: OperationChipSet["denominations"][number]; quantity: number }[]
  }>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = mode === "entry"

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      chipSetId: chipSets[0]?.id ?? "",
      category: entry ? "" : "DAMAGE",
      reason: "",
      notes: "",
      quantities: {},
    },
  })
  const chipSetId = useWatch({ control: form.control, name: "chipSetId" })
  const set = chipSets.find((s) => s.id === chipSetId)
  const denominations = (set?.denominations ?? []).filter((d) =>
    entry ? d.isActive : d.available > 0
  )

  function onReview(values: Values) {
    setError(null)
    const lines = denominations
      .map((d) => ({
        d,
        quantity: parseQuantity(values.quantities[d.denominationId] ?? ""),
      }))
      .filter((l) => l.quantity !== null && l.quantity !== 0)
    if (lines.some((l) => Number.isNaN(l.quantity)))
      return setError("Usa solo números enteros.")
    if (lines.length === 0)
      return setError("Captura la cantidad de al menos una denominación.")
    if (!entry) {
      const over = lines.find((l) => (l.quantity as number) > l.d.available)
      if (over)
        return setError(
          `Solo hay ${over.d.available} disponibles de ${denominationTitle(over.d)}.`
        )
    }
    setReview({
      lines: lines as {
        d: OperationChipSet["denominations"][number]
        quantity: number
      }[],
    })
  }

  async function confirm() {
    if (!review) return
    const values = form.getValues()
    setBusy(true)
    try {
      await apiRequest(
        `/api/chip-inventory/${entry ? "entries" : "withdrawals"}`,
        {
          method: "POST",
          body: {
            chipSetId: values.chipSetId,
            ...(entry ? {} : { category: values.category }),
            lines: review.lines.map((l) => ({
              denominationId: l.d.denominationId,
              quantity: l.quantity,
            })),
            reason: values.reason,
            notes: values.notes,
            idempotencyKey: key,
          },
        }
      )
      toast.success(entry ? "Entrada registrada" : "Baja registrada")
      renewKey()
      setReview(null)
      form.reset({ ...values, reason: "", notes: "", quantities: {} })
      router.refresh()
    } catch (e) {
      setReview(null)
      setError(e instanceof Error ? e.message : "No se pudo registrar")
    } finally {
      setBusy(false)
    }
  }

  const total =
    review?.lines.reduce((acc, l) => acc + l.quantity * Number(l.d.value), 0) ??
    0

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onReview)}
        className="space-y-4"
        noValidate
      >
        {chipSets.length === 1 ? (
          <SharedInventoryNote name={chipSets[0].name} />
        ) : (
          <FormField
            control={form.control}
            name="chipSetId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Inventario de fichas</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {chipSets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {!entry ? (
          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Causa de la baja</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {WITHDRAWAL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {WITHDRAWAL_CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
              </FormItem>
            )}
          />
        ) : null}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Cantidades por denominación
          </legend>
          {denominations.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {entry
                ? "No hay denominaciones activas en el inventario."
                : "No hay fichas disponibles para dar de baja."}
            </p>
          ) : (
            denominations.map((d) => (
              <div
                key={d.denominationId}
                className="flex items-center justify-between gap-3"
              >
                <label htmlFor={`op-${d.denominationId}`} className="text-sm">
                  {denominationTitle(d)}
                  <span className="text-muted-foreground block text-xs">
                    Disponibles: {formatChips(d.available)}
                  </span>
                </label>
                <QuantityInput
                  id={`op-${d.denominationId}`}
                  className="w-28"
                  placeholder="0"
                  aria-label={`Cantidad de ${denominationTitle(d)}`}
                  {...form.register(`quantities.${d.denominationId}`)}
                />
              </div>
            ))
          )}
        </fieldset>

        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Motivo</FormLabel>
              <FormControl>
                <Input
                  className="h-11 md:h-9"
                  placeholder={
                    entry ? "Compra de fichas nuevas" : "Fichas dañadas"
                  }
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Observaciones (opcional)</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          className="h-11 w-full md:h-9 md:w-auto"
          disabled={denominations.length === 0}
        >
          Revisar {entry ? "entrada" : "baja"}
        </Button>
      </form>

      <ConfirmSummaryDialog
        open={review !== null}
        busy={busy}
        title={
          entry ? "Confirmar entrada de fichas" : "Confirmar baja definitiva"
        }
        description={
          entry
            ? "Se incorporan al inventario común. No genera ingresos en caja."
            : "Las fichas salen del inventario activo. No es un gasto financiero."
        }
        onCancel={() => setReview(null)}
        onConfirm={confirm}
      >
        <ul className="divide-y">
          {review?.lines.map((l) => (
            <li
              key={l.d.denominationId}
              className="flex justify-between py-1.5"
            >
              <span>{denominationTitle(l.d)}</span>
              <span className="tabular-nums">
                {entry ? "+" : "−"}
                {formatChips(l.quantity)}
              </span>
            </li>
          ))}
        </ul>
        <p className="pt-2 font-medium">
          Valor nominal: {formatNominal(total)}
        </p>
        <p className="text-muted-foreground pt-1">
          Motivo: {form.getValues("reason")}
        </p>
      </ConfirmSummaryDialog>
    </Form>
  )
}
