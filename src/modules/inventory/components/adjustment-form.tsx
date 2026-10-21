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
} from "@/modules/inventory/components/format"
import { QuantityInput } from "@/modules/inventory/components/quantity-input"
import type { OperationChipSet } from "@/modules/inventory/components/stock-operation-form"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  ADJUSTMENT_KIND_LABEL,
  ADJUSTMENT_KINDS,
} from "@/modules/inventory/inventory.schemas"

const schema = z.object({
  chipSetId: z.string().min(1, "Selecciona el inventario"),
  denominationId: z.string().min(1, "Selecciona la denominación"),
  kind: z.enum(ADJUSTMENT_KINDS),
  direction: z.enum(["INCREASE", "DECREASE"]),
  quantity: z.string().regex(/^[1-9]\d{0,6}$/, "Entero mayor que cero"),
  reason: z
    .string()
    .trim()
    .min(3, "El motivo es obligatorio (mínimo 3 caracteres)")
    .max(300),
  notes: z.string().max(500),
})
type Values = z.infer<typeof schema>

/**
 * Ajuste sin aprobación adicional (los tres roles). Muestra el saldo
 * anterior y el resultante antes de confirmar; el servidor los vuelve a
 * calcular bajo bloqueo y rechaza existencias negativas.
 */
export function AdjustmentForm({ chipSets }: { chipSets: OperationChipSet[] }) {
  const router = useRouter()
  const [key, renewKey] = useIdempotencyKey()
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      chipSetId: chipSets[0]?.id ?? "",
      denominationId: "",
      kind: "SHORTAGE",
      direction: "DECREASE",
      quantity: "",
      reason: "",
      notes: "",
    },
  })
  const [chipSetId, denominationId, kind, direction, quantity] = useWatch({
    control: form.control,
    name: ["chipSetId", "denominationId", "kind", "direction", "quantity"],
  })
  const set = chipSets.find((s) => s.id === chipSetId)
  const d = set?.denominations.find((x) => x.denominationId === denominationId)
  const sign =
    kind === "SURPLUS" || (kind === "CORRECTION" && direction === "INCREASE")
      ? 1
      : -1
  const qty = /^\d+$/.test(quantity) ? Number(quantity) : 0
  const after = d ? d.custody + sign * qty : null

  function onReview() {
    setError(null)
    if (d && sign < 0 && qty > d.available) {
      return setError(
        `Solo hay ${d.available} disponibles: el ajuste no puede dejar existencias negativas ni tocar reservadas.`
      )
    }
    setReviewing(true)
  }

  async function confirm() {
    const v = form.getValues()
    setBusy(true)
    try {
      await apiRequest("/api/chip-inventory/adjustments", {
        method: "POST",
        body: {
          chipSetId: v.chipSetId,
          denominationId: v.denominationId,
          kind: v.kind,
          ...(v.kind === "CORRECTION" ? { direction: v.direction } : {}),
          quantity: Number(v.quantity),
          reason: v.reason,
          notes: v.notes,
          idempotencyKey: key,
        },
      })
      toast.success("Ajuste registrado")
      renewKey()
      setReviewing(false)
      form.reset({ ...v, quantity: "", reason: "", notes: "" })
      router.refresh()
    } catch (e) {
      setReviewing(false)
      setError(e instanceof Error ? e.message : "No se pudo registrar")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onReview)}
        className="space-y-4"
        noValidate
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                    <NativeSelect
                      {...field}
                      onChange={(e) => {
                        field.onChange(e)
                        form.setValue("denominationId", "")
                      }}
                    >
                      {chipSets.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormControl>
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="denominationId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Denominación</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    <option value="">Selecciona…</option>
                    {set?.denominations.map((x) => (
                      <option key={x.denominationId} value={x.denominationId}>
                        {denominationTitle(x)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="kind"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tipo de ajuste</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {ADJUSTMENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ADJUSTMENT_KIND_LABEL[k]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
              </FormItem>
            )}
          />
          {kind === "CORRECTION" ? (
            <FormField
              control={form.control}
              name="direction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>La corrección…</FormLabel>
                  <FormControl>
                    <NativeSelect {...field}>
                      <option value="DECREASE">Disminuye la existencia</option>
                      <option value="INCREASE">Aumenta la existencia</option>
                    </NativeSelect>
                  </FormControl>
                </FormItem>
              )}
            />
          ) : null}
          <FormField
            control={form.control}
            name="quantity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cantidad de fichas</FormLabel>
                <FormControl>
                  <QuantityInput placeholder="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {d ? (
          <p
            className="bg-muted rounded-md p-3 text-sm"
            data-testid="adjustment-preview"
          >
            Bajo custodia: <strong>{formatChips(d.custody)}</strong> →{" "}
            <strong>{after !== null ? formatChips(after) : "—"}</strong>
            <span className="text-muted-foreground block text-xs">
              Disponibles: {formatChips(d.available)}
            </span>
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Motivo</FormLabel>
              <FormControl>
                <Input
                  className="h-11 md:h-9"
                  placeholder="Faltante detectado en conteo"
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
            </FormItem>
          )}
        />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11 w-full md:h-9 md:w-auto">
          Revisar ajuste
        </Button>
      </form>

      <ConfirmSummaryDialog
        open={reviewing}
        busy={busy}
        title="Confirmar ajuste de inventario"
        description="No requiere aprobación adicional. Quedará registrado con tu usuario y el motivo; no modifica la caja."
        onCancel={() => setReviewing(false)}
        onConfirm={confirm}
      >
        {d ? (
          <>
            <p>
              {ADJUSTMENT_KIND_LABEL[kind]} · {denominationTitle(d)}
            </p>
            <p className="tabular-nums">
              {formatChips(d.custody)} {sign > 0 ? "+" : "−"} {formatChips(qty)}{" "}
              = <strong>{after !== null ? formatChips(after) : "—"}</strong>
            </p>
            <p className="text-muted-foreground pt-1">
              Motivo: {form.getValues("reason")}
            </p>
          </>
        ) : null}
      </ConfirmSummaryDialog>
    </Form>
  )
}
