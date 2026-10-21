"use client"

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  XCircle,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { cn } from "@/lib/utils"
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
import type { StockCountView } from "@/modules/inventory/stock-count.service"

/**
 * Captura rápida de un arqueo del inventario común, confirmación y
 * conciliación. Las diferencias y totales definitivos los calcula el
 * servidor; aquí solo se muestran.
 */
export function CountWorkspace({
  count,
  canOperate,
  closureSessionId,
}: {
  count: StockCountView
  canOperate: boolean
  /**
   * Arqueo final del CIERRE (Módulo 12): se confirma por el endpoint del
   * cierre y sus diferencias se resuelven allí (recuento o ajuste
   * autorizado), nunca con la conciliación directa.
   */
  closureSessionId?: string
}) {
  const router = useRouter()
  const draft = count.status === "DRAFT" && canOperate
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      count.details.map((d) => [
        d.denominationId,
        d.countedQuantity === null ? "" : String(d.countedQuantity),
      ])
    )
  )
  const [busy, setBusy] = useState<
    null | "save" | "refresh" | "confirm" | "reconcile" | "cancel"
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [reconciling, setReconciling] = useState(false)
  const [confirmKey] = useIdempotencyKey()
  const [reconcileKey, renewReconcileKey] = useIdempotencyKey()

  const rows = count.details.map((d) => {
    const counted = draft
      ? parseQuantity(values[d.denominationId] ?? "")
      : d.countedQuantity
    const diff =
      counted === null || Number.isNaN(counted)
        ? null
        : counted - d.expectedQuantity
    return { ...d, counted, diff }
  })
  const invalid = rows.some((r) => Number.isNaN(r.counted))
  const missing = rows.filter((r) => r.counted === null).length

  async function save(silent = false) {
    if (invalid) {
      setError("Usa solo números enteros.")
      return false
    }
    setBusy("save")
    try {
      await apiRequest(`/api/chip-inventory/counts/${count.id}`, {
        method: "PATCH",
        body: {
          lines: rows.map((r) => ({
            denominationId: r.denominationId,
            countedQuantity: r.counted,
          })),
        },
      })
      if (!silent) toast.success("Conteo guardado (no modifica el inventario)")
      router.refresh()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar")
      return false
    } finally {
      setBusy(null)
    }
  }

  async function refreshExpected() {
    setBusy("refresh")
    try {
      await apiRequest(`/api/chip-inventory/counts/${count.id}`, {
        method: "PATCH",
        body: { refreshExpected: true },
      })
      toast.info(
        "Esperado actualizado: vuelve a contar las denominaciones marcadas"
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo actualizar")
    } finally {
      setBusy(null)
    }
  }

  async function confirmCount() {
    setError(null)
    if (!(await save(true))) return setConfirming(false)
    setBusy("confirm")
    try {
      if (closureSessionId) {
        await apiRequest(
          `/api/sessions/${closureSessionId}/closure/inventory-count`,
          {
            method: "POST",
            body: {
              action: "confirm",
              countId: count.id,
              idempotencyKey: confirmKey,
            },
          }
        )
      } else {
        await apiRequest(`/api/chip-inventory/counts/${count.id}/confirm`, {
          method: "POST",
          body: { idempotencyKey: confirmKey },
        })
      }
      toast.success("Arqueo confirmado")
      setConfirming(false)
      router.refresh()
    } catch (e) {
      setConfirming(false)
      if (
        e instanceof ApiClientError &&
        (e.details as { stale?: boolean } | undefined)?.stale
      ) {
        setError(
          "Las existencias cambiaron mientras contabas. Pulsa “Actualizar esperado” y vuelve a verificar."
        )
      } else {
        setError(e instanceof Error ? e.message : "No se pudo confirmar")
      }
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function reconcile() {
    setBusy("reconcile")
    try {
      await apiRequest(`/api/chip-inventory/counts/${count.id}/reconcile`, {
        method: "POST",
        body: { reason, notes, idempotencyKey: reconcileKey },
      })
      toast.success("Diferencias conciliadas con un ajuste")
      renewReconcileKey()
      setReconciling(false)
      router.refresh()
    } catch (e) {
      setReconciling(false)
      setError(e instanceof Error ? e.message : "No se pudo conciliar")
    } finally {
      setBusy(null)
    }
  }

  async function cancel() {
    setBusy("cancel")
    try {
      await apiRequest(`/api/chip-inventory/counts/${count.id}/cancel`, {
        method: "POST",
      })
      toast.success("Arqueo cancelado")
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cancelar")
    } finally {
      setBusy(null)
    }
  }

  const withDiff = rows.filter((r) => r.diff !== null && r.diff !== 0)

  return (
    <div className="space-y-4">
      {count.stale && draft ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          data-testid="count-stale"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            Las existencias cambiaron después de iniciar el conteo. Actualiza el
            esperado y vuelve a verificar.
          </span>
          <Button
            variant="outline"
            className="h-11 md:h-8"
            onClick={refreshExpected}
            disabled={busy !== null}
          >
            {busy === "refresh" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Actualizar esperado
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Conteo por denominación
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Cuenta las fichas que están en el inventario (incluidas las
            reservadas). Las fichas en circulación no se cuentan aquí.
          </p>
          <p className="text-xs" data-testid="count-expected-value">
            Valor esperado bajo custodia:{" "}
            <span className="font-medium">
              {formatNominal(count.expectedTotal)}
            </span>
          </p>
          {count.breakdownExact ? null : (
            <p
              className="text-xs text-amber-700 dark:text-amber-400"
              data-testid="count-breakdown-inexact"
            >
              Hubo entregas o devoluciones por importe desde el último arqueo:
              las cantidades por denominación son solo una referencia. Se
              compara el VALOR total contado contra el esperado.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y" data-testid="count-lines">
            {rows.map((r) => (
              <li
                key={r.denominationId}
                className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2.5"
                data-testid="count-line"
              >
                <Label htmlFor={`c-${r.denominationId}`} className="text-sm">
                  {denominationTitle({
                    value: r.unitValue,
                    color: r.color,
                    name: r.name,
                  })}
                  {!r.isActive ? (
                    <span className="text-muted-foreground"> (inactiva)</span>
                  ) : null}
                </Label>
                {draft ? (
                  <QuantityInput
                    id={`c-${r.denominationId}`}
                    className="w-24"
                    placeholder="—"
                    value={values[r.denominationId] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [r.denominationId]: e.target.value,
                      }))
                    }
                    aria-label={`Contadas de ${denominationTitle({ value: r.unitValue, color: r.color })}`}
                  />
                ) : (
                  <span className="text-right tabular-nums">
                    {r.counted === null
                      ? "—"
                      : formatChips(r.counted as number)}
                  </span>
                )}
                <p className="text-muted-foreground col-span-2 text-xs tabular-nums">
                  {count.breakdownExact ? "Esperado" : "Referencia"}{" "}
                  {formatChips(r.expectedQuantity)}
                  {r.diff !== null ? (
                    <span
                      data-testid="count-diff"
                      className={cn(
                        "ml-2 font-medium",
                        r.diff < 0 && "text-destructive",
                        r.diff > 0 && "text-amber-700 dark:text-amber-400",
                        r.diff === 0 && "text-emerald-700 dark:text-emerald-400"
                      )}
                    >
                      Diferencia {r.diff > 0 ? "+" : ""}
                      {formatChips(r.diff)} (
                      {formatNominal(r.diff * Number(r.unitValue))})
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
          {count.status !== "DRAFT" ? (
            <dl className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Esperado</dt>
                <dd className="font-medium">
                  {formatNominal(count.expectedTotal)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Contado</dt>
                <dd className="font-medium">
                  {formatNominal(count.countedTotal)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Diferencia</dt>
                <dd
                  className="font-medium"
                  data-testid="count-difference-total"
                >
                  {formatNominal(count.differenceTotal)}
                </dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {draft ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => save()}
            disabled={busy !== null}
          >
            {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
            Guardar borrador
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={busy !== null || count.stale}
            onClick={() => {
              setError(null)
              if (invalid) return setError("Usa solo números enteros.")
              if (missing > 0)
                return setError(
                  `Captura todas las denominaciones (faltan ${missing}).`
                )
              setConfirming(true)
            }}
          >
            <CheckCircle2 />
            Confirmar conteo
          </Button>
          <Button
            variant="ghost"
            className="h-11 md:h-9"
            onClick={cancel}
            disabled={busy !== null}
          >
            <XCircle />
            Cancelar arqueo
          </Button>
        </div>
      ) : null}

      {count.status === "CONFIRMED" &&
      count.reconciliationStatus === "PENDING" &&
      closureSessionId ? (
        <p
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          data-testid="closure-count-difference"
        >
          Hay una diferencia FÍSICA de arqueo: el cierre queda bloqueado hasta
          resolverla en Diferencias (recuento, regreso a Abierta o ajuste
          autorizado por un socio).
        </p>
      ) : null}

      {count.status === "CONFIRMED" &&
      count.reconciliationStatus === "PENDING" &&
      canOperate &&
      !closureSessionId ? (
        <Card data-testid="reconcile-panel">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Conciliar diferencias
            </CardTitle>
            <p className="text-muted-foreground text-sm">
              Se registrará un ajuste por cada diferencia, ligado a este arqueo.
              Sin aprobación adicional; el motivo es obligatorio.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rec-reason">Motivo</Label>
              <Input
                id="rec-reason"
                className="h-11 md:h-9"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Diferencia confirmada tras recontar"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-notes">Observaciones (opcional)</Label>
              <Input
                id="rec-notes"
                className="h-11 md:h-9"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button
              className="h-11 md:h-9"
              disabled={reason.trim().length < 3 || busy !== null}
              onClick={() => setReconciling(true)}
            >
              Revisar ajuste de conciliación
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmSummaryDialog
        open={confirming}
        busy={busy === "confirm" || busy === "save"}
        title="Confirmar conteo"
        description="El conteo quedará fijo. Confirmar NO ajusta el inventario: las diferencias se concilian después, de forma explícita."
        onCancel={() => setConfirming(false)}
        onConfirm={confirmCount}
      >
        {withDiff.length === 0 ? (
          <p>
            Sin diferencias: el conteo coincide con lo esperado en todas las
            denominaciones.
          </p>
        ) : (
          <ul className="divide-y">
            {withDiff.map((r) => (
              <li
                key={r.denominationId}
                className="flex justify-between py-1.5"
              >
                <span>
                  {denominationTitle({ value: r.unitValue, color: r.color })}
                </span>
                <span className="tabular-nums">
                  {r.diff! > 0 ? "+" : ""}
                  {formatChips(r.diff!)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ConfirmSummaryDialog>

      <ConfirmSummaryDialog
        open={reconciling}
        busy={busy === "reconcile"}
        title="Confirmar conciliación"
        description="Se aplicará una sola vez y quedará en el libro de movimientos."
        confirmLabel="Conciliar"
        onCancel={() => setReconciling(false)}
        onConfirm={reconcile}
      >
        <ul className="divide-y">
          {rows
            .filter((r) => r.differenceQuantity && r.differenceQuantity !== 0)
            .map((r) => (
              <li
                key={r.denominationId}
                className="flex justify-between py-1.5"
              >
                <span>
                  {denominationTitle({ value: r.unitValue, color: r.color })}
                </span>
                <span className="tabular-nums">
                  {r.differenceQuantity! > 0 ? "Sobrante +" : "Faltante "}
                  {formatChips(r.differenceQuantity!)}
                </span>
              </li>
            ))}
        </ul>
        <p className="text-muted-foreground pt-2">Motivo: {reason}</p>
      </ConfirmSummaryDialog>
    </div>
  )
}
