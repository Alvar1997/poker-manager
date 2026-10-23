"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
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
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  PurchaseSignaturePad,
  type PadStrokes,
} from "@/modules/signatures/components/purchase-signature-pad"

/**
 * Acciones de liquidación (cliente). Aquí solo se CAPTURA: el valor nominal
 * total devuelto (nunca denominaciones), la decisión explícita de compensar
 * y, si es parcial, su importe. La distribución FIFO, el neto, la sesión,
 * la caja de origen y los saldos los decide el SERVIDOR; la vista previa es
 * informativa y se recalcula al confirmar.
 */

const BASE = "/dashboard/liquidaciones"
const MONEY = /^\d{1,10}(\.\d{1,2})?$/
const positive = (v: string) => MONEY.test(v) && /[1-9]/.test(v)

function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : fallback
}

function MoneyInput({
  id,
  value,
  onChange,
  big = false,
  testId,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  big?: boolean
  testId?: string
}) {
  return (
    <div className="relative">
      <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg">
        $
      </span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className={cn(
          "pl-7 tabular-nums",
          big
            ? "h-14 text-2xl font-semibold md:h-12 md:text-xl"
            : "h-12 text-lg"
        )}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        data-testid={testId}
      />
    </div>
  )
}

type Decision = "NO_COMPENSATE" | "PARTIAL" | "MAXIMUM"

type Preview =
  | {
      valid: true
      returnedNominalAmount: string
      outstandingDebt: string
      offsetAmount: string
      netPayoutAmount: string
      remainingDebt: string
      allocations: {
        receivableId: string
        order: number
        purchaseFolio: string
        tableName: string
        sessionFolio: string
        amount: string
        balanceAfter: string
      }[]
    }
  | { valid: false; message: string }

const DECISIONS: { value: Decision; label: string; hint: string }[] = [
  {
    value: "NO_COMPENSATE",
    label: "No compensar",
    hint: "El jugador conserva su deuda; se le paga todo lo devuelto.",
  },
  {
    value: "PARTIAL",
    label: "Compensar parcialmente",
    hint: "Indica cuánto aplicar a sus deudas (las más antiguas primero).",
  },
  {
    value: "MAXIMUM",
    label: "Compensar el máximo posible",
    hint: "El sistema aplica lo menor entre las fichas y la deuda.",
  },
]

/**
 * Pasos 2–6: valor nominal devuelto, decisión explícita de compensación,
 * vista previa FIFO y pago neto. Crea el borrador (o edita uno existente,
 * lo que invalida la firma anterior) y lleva a la firma del jugador.
 */
export function SettlementAmountsForm({
  participationId,
  outstanding,
  edit,
  onCreated,
}: {
  participationId: string
  outstanding: string
  /** Opcional (mesa interactiva): en vez de navegar a la firma. */
  onCreated?: (settlementId: string) => void
  edit?: {
    settlementId: string
    version: number
    returnedNominalAmount: string
    offsetDecision: Decision
    requestedOffsetAmount: string | null
  }
}) {
  const router = useRouter()
  const [returned, setReturned] = useState(edit?.returnedNominalAmount ?? "")
  const [decision, setDecision] = useState<Decision | null>(
    edit?.offsetDecision ?? null
  )
  const [offset, setOffset] = useState(edit?.requestedOffsetAmount ?? "")
  const [key] = useIdempotencyKey()
  const hasDebt = outstanding !== "0.00"
  const validReturned = MONEY.test(returned)
  const validOffset = decision !== "PARTIAL" || positive(offset)
  const query = new URLSearchParams({
    participationId,
    returnedNominalAmount: returned,
    offsetDecision: decision ?? "NO_COMPENSATE",
    ...(decision === "PARTIAL" && offset ? { offsetAmount: offset } : {}),
  })
  const preview = useQuery({
    queryKey: ["settlement-preview", query.toString()],
    queryFn: () =>
      apiRequest<Preview>(`/api/settlements/preview?${query.toString()}`),
    enabled: validReturned && decision !== null && validOffset,
  })
  const submit = useMutation({
    mutationFn: () => {
      const body = {
        returnedNominalAmount: returned,
        offsetDecision: decision,
        ...(decision === "PARTIAL" ? { offsetAmount: offset } : {}),
      }
      return edit
        ? apiRequest<{ id: string }>(
            `/api/settlements/${edit.settlementId}/draft`,
            {
              method: "PATCH",
              body: {
                ...body,
                expectedVersion: edit.version,
                ...(decision !== "PARTIAL" ? { offsetAmount: null } : {}),
              },
            }
          )
        : apiRequest<{ id: string }>("/api/settlements", {
            method: "POST",
            body: { ...body, participationId, idempotencyKey: key },
          })
    },
    onSuccess: (s) => {
      toast.success(
        edit
          ? "Liquidación actualizada: el jugador debe firmar el nuevo resumen."
          : "Liquidación preparada. Ahora firma el jugador."
      )
      if (onCreated) onCreated(s.id)
      else router.push(`${BASE}/${s.id}/firma`)
    },
    onError: (e) =>
      toast.error(errorText(e, "No se pudo preparar la liquidación")),
  })
  const ok = preview.data?.valid === true ? preview.data : null
  const ready =
    validReturned &&
    decision !== null &&
    validOffset &&
    ok !== null &&
    !submit.isPending
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) submit.mutate()
      }}
      data-testid="settlement-form"
    >
      <section className="space-y-1">
        <Label htmlFor="returned" className="text-base">
          2 · Valor nominal devuelto
        </Label>
        <MoneyInput
          id="returned"
          big
          value={returned}
          onChange={setReturned}
          testId="returned-amount"
        />
        <p className="text-muted-foreground text-xs">
          Solo el importe total. Puede ser $0. No se capturan denominaciones:
          las cantidades por ficha se verifican en los arqueos.
        </p>
      </section>

      <section className="space-y-1">
        <p className="text-base font-medium">3 · Deuda pendiente del jugador</p>
        <p
          className="text-lg font-semibold tabular-nums"
          data-testid="outstanding-debt"
        >
          {formatMXN(outstanding)}
        </p>
        <p className="text-muted-foreground text-xs">
          Saldo global (todas las sesiones y mesas). Informativo: se revalida al
          confirmar.
        </p>
      </section>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-base font-medium">
          4 · ¿Compensar deuda?
        </legend>
        {DECISIONS.map((d) => {
          const disabled =
            d.value !== "NO_COMPENSATE" &&
            (!hasDebt || returned === "" || /^0*(\.0*)?$/.test(returned))
          return (
            <label
              key={d.value}
              className={cn(
                "flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm",
                decision === d.value && "border-primary bg-primary/5",
                disabled && "cursor-not-allowed opacity-50"
              )}
            >
              <input
                type="radio"
                name="offsetDecision"
                className="mt-0.5 size-5"
                value={d.value}
                checked={decision === d.value}
                disabled={disabled}
                onChange={() => setDecision(d.value)}
                data-testid={`offset-${d.value}`}
              />
              <span>
                <span className="font-medium">{d.label}</span>
                <span className="text-muted-foreground block text-xs">
                  {d.hint}
                </span>
              </span>
            </label>
          )
        })}
        {decision === "PARTIAL" ? (
          <div className="space-y-1">
            <Label htmlFor="offset">Importe a compensar</Label>
            <MoneyInput
              id="offset"
              value={offset}
              onChange={setOffset}
              testId="offset-amount"
            />
          </div>
        ) : null}
      </fieldset>

      {decision !== null && validReturned ? (
        <section className="space-y-2" data-testid="settlement-preview">
          <p className="text-base font-medium">5 · Aplicación FIFO prevista</p>
          {preview.isFetching ? (
            <p className="text-muted-foreground text-sm">Calculando…</p>
          ) : preview.data?.valid === false ? (
            <p className="text-destructive text-sm" role="alert">
              {preview.data.message}
            </p>
          ) : ok ? (
            <>
              {ok.allocations.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Sin compensación: la deuda queda en{" "}
                  {formatMXN(ok.remainingDebt)}.
                </p>
              ) : (
                <ol className="divide-y rounded-lg border">
                  {ok.allocations.map((a) => (
                    <li
                      key={a.receivableId}
                      className="flex justify-between gap-2 p-2 text-sm"
                    >
                      <span>
                        {a.order}.{" "}
                        <span className="font-mono">{a.purchaseFolio}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {a.tableName} · {a.sessionFolio}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {formatMXN(a.amount)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="text-muted-foreground text-xs">
                Automática por antigüedad; no se eligen deudas a mano.
              </p>
              <dl className="bg-muted/50 divide-y rounded-lg p-3">
                <div className="flex justify-between py-1 text-sm">
                  <dt>Fichas devueltas</dt>
                  <dd className="tabular-nums">
                    {formatMXN(ok.returnedNominalAmount)}
                  </dd>
                </div>
                <div className="flex justify-between py-1 text-sm">
                  <dt>Compensación</dt>
                  <dd className="tabular-nums" data-testid="preview-offset">
                    − {formatMXN(ok.offsetAmount)}
                  </dd>
                </div>
                <div className="flex justify-between py-1 text-sm">
                  <dt>Deuda restante</dt>
                  <dd className="tabular-nums" data-testid="preview-remaining">
                    {formatMXN(ok.remainingDebt)}
                  </dd>
                </div>
                <div className="flex justify-between py-1 text-base font-semibold">
                  <dt>6 · Pago neto al jugador</dt>
                  <dd className="tabular-nums" data-testid="preview-net">
                    {formatMXN(ok.netPayoutAmount)}
                  </dd>
                </div>
              </dl>
            </>
          ) : null}
        </section>
      ) : null}

      <Button
        type="submit"
        className="h-12 w-full"
        disabled={!ready}
        data-testid="settlement-submit"
      >
        {submit.isPending ? <Loader2 className="animate-spin" /> : null}
        {edit ? "Guardar y volver a firmar" : "Continuar a la firma"}
      </Button>
    </form>
  )
}

/** Paso 7: firma del jugador sobre el resumen preparado por el servidor. */
export function SettlementSignatureCapture({
  settlementId,
  snapshotId,
  payloadHash,
  onDone,
}: {
  settlementId: string
  snapshotId: string
  payloadHash: string
  onDone?: () => void
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [reviewed, setReviewed] = useState(false)
  const capture = useMutation({
    mutationFn: (strokes: PadStrokes) =>
      apiRequest(`/api/settlements/${settlementId}/signatures`, {
        method: "POST",
        body: { snapshotId, payloadHash, strokes, idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      toast.success("Firma registrada. El cajero debe confirmar la recepción.")
      onDone?.()
      router.refresh()
    },
    onError: (e) => {
      toast.error(errorText(e, "No se pudo registrar la firma"))
      if (e instanceof ApiClientError && e.status === 409) {
        renew()
        onDone?.()
        router.refresh()
      }
    },
  })
  return (
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          data-testid="summary-reviewed"
        />
        El jugador revisó las fichas, la compensación y el pago neto
      </label>
      <PurchaseSignaturePad
        pending={capture.isPending}
        disabled={!reviewed}
        onConfirm={(strokes) => capture.mutate(strokes)}
      />
    </div>
  )
}

/**
 * Paso 8 (+ 9 opcional): el cajero confirma la recepción física. Puede
 * pagar en ese mismo momento una parte o todo en efectivo de la caja de la
 * sesión; lo demás queda pendiente de pago.
 */
export function ConfirmReturnForm({
  settlementId,
  version,
  net,
  cashAvailable,
  onDone,
}: {
  settlementId: string
  version: number
  net: string
  cashAvailable: string
  /** Opcional (mesa interactiva): en vez de navegar al comprobante o a pagos. */
  onDone?: (status: string) => void
}) {
  const router = useRouter()
  const [received, setReceived] = useState(false)
  const [payNow, setPayNow] = useState(false)
  const [amount, setAmount] = useState("")
  const [delivered, setDelivered] = useState(false)
  const [key] = useIdempotencyKey()
  const confirm = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; status: string }>(
        `/api/settlements/${settlementId}/confirm-return`,
        {
          method: "POST",
          body: {
            expectedVersion: version,
            chipsReceived: received,
            ...(payNow
              ? { immediateCashAmount: amount, cashDelivered: delivered }
              : {}),
            idempotencyKey: key,
          },
        }
      ),
    onSuccess: (s) => {
      toast.success(
        s.status === "COMPLETED"
          ? "Recepción confirmada: liquidación pagada."
          : "Recepción confirmada: queda pago pendiente."
      )
      if (onDone) {
        onDone(s.status)
        router.refresh()
      } else
        router.push(
          s.status === "COMPLETED"
            ? `${BASE}/${settlementId}/comprobante`
            : `${BASE}/${settlementId}/pagos`
        )
    },
    onError: (e) => {
      toast.error(errorText(e, "No se pudo confirmar la recepción"))
      if (e instanceof ApiClientError && e.status === 409) {
        onDone?.("CONFLICT")
        router.refresh()
      }
    },
  })
  const hasNet = net !== "0.00"
  const ready =
    received &&
    (!payNow || (positive(amount) && delivered)) &&
    !confirm.isPending
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) confirm.mutate()
      }}
      data-testid="confirm-return-form"
    >
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-5"
          checked={received}
          onChange={(e) => setReceived(e.target.checked)}
          data-testid="chips-received"
        />
        Recibí físicamente las fichas del jugador
      </label>
      {hasNet ? (
        <>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={payNow}
              onChange={(e) => setPayNow(e.target.checked)}
              data-testid="pay-now"
            />
            Pagar ahora en efectivo (todo o una parte)
          </label>
          {payNow ? (
            <div className="space-y-2 rounded-lg border p-3">
              <Label htmlFor="immediate">Efectivo entregado ahora</Label>
              <MoneyInput
                id="immediate"
                value={amount}
                onChange={setAmount}
                testId="immediate-cash"
              />
              <p className="text-muted-foreground text-xs">
                Pago neto {formatMXN(net)} · efectivo en caja{" "}
                {formatMXN(cashAvailable)}. La caja nunca queda negativa.
              </p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={delivered}
                  onChange={(e) => setDelivered(e.target.checked)}
                  data-testid="cash-delivered"
                />
                Entregué este efectivo al jugador
              </label>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              Si no pagas ahora, el pago neto queda pendiente y se registra
              después (efectivo o transferencia).
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          Pago neto $0: la liquidación termina al confirmar.
        </p>
      )}
      <Button
        type="submit"
        className="h-12 w-full"
        disabled={!ready}
        data-testid="confirm-return"
      >
        {confirm.isPending ? <Loader2 className="animate-spin" /> : null}
        Confirmar recepción de fichas
      </Button>
    </form>
  )
}

/** Paso 9: registrar un pago (efectivo entregado o transferencia en trámite). */
export function RegisterPayoutForm({
  settlementId,
  available,
  cashSource,
}: {
  settlementId: string
  available: string
  cashSource: "SESSION_CASH" | "ADMIN_CUSTODY"
}) {
  const router = useRouter()
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER">("CASH")
  const [amount, setAmount] = useState("")
  const [delivered, setDelivered] = useState(false)
  const [reference, setReference] = useState("")
  const [key, renew] = useIdempotencyKey()
  const pay = useMutation({
    mutationFn: () =>
      apiRequest(`/api/settlements/${settlementId}/payouts`, {
        method: "POST",
        body:
          method === "CASH"
            ? { method, amount, cashDelivered: delivered, idempotencyKey: key }
            : {
                method,
                amount,
                ...(reference ? { bankReference: reference } : {}),
                idempotencyKey: key,
              },
      }),
    onSuccess: () => {
      renew()
      setAmount("")
      setDelivered(false)
      setReference("")
      toast.success(
        method === "CASH"
          ? "Pago en efectivo registrado"
          : "Transferencia registrada en trámite (aún no cuenta como pagada)"
      )
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo registrar el pago")),
  })
  const ready =
    positive(amount) && (method !== "CASH" || delivered) && !pay.isPending
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) pay.mutate()
      }}
      data-testid="payout-form"
    >
      <p className="text-sm">
        Disponible para registrar:{" "}
        <strong data-testid="payout-available">{formatMXN(available)}</strong>
      </p>
      <div className="space-y-1">
        <Label htmlFor="payoutMethod">Método</Label>
        <NativeSelect
          id="payoutMethod"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as "CASH" | "BANK_TRANSFER")
            setDelivered(false)
          }}
          data-testid="payout-method"
        >
          <option value="CASH">Efectivo</option>
          <option value="BANK_TRANSFER">Transferencia bancaria</option>
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          {method === "CASH"
            ? cashSource === "SESSION_CASH"
              ? "Sale de la caja de la sesión de esta liquidación."
              : "La sesión ya cerró: sale de tu custodia administrativa (nunca de la caja cerrada)."
            : "Queda en trámite: no cuenta como pagada hasta verificarla en el banco."}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="payoutAmount">Importe</Label>
        <MoneyInput
          id="payoutAmount"
          value={amount}
          onChange={setAmount}
          testId="payout-amount"
        />
      </div>
      {method === "CASH" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={delivered}
            onChange={(e) => setDelivered(e.target.checked)}
            data-testid="payout-cash-delivered"
          />
          Entregué este efectivo al jugador
        </label>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="payoutRef">Referencia (opcional)</Label>
          <Input
            id="payoutRef"
            className="h-11 md:h-9"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      )}
      <Button
        type="submit"
        className="h-11 w-full sm:w-auto"
        disabled={!ready}
        data-testid="payout-submit"
      >
        {pay.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar pago
      </Button>
    </form>
  )
}

/** Resolver una transferencia saliente en trámite (verificación manual). */
export function ResolveTransferActions({
  settlementId,
  payoutId,
  canResolve,
}: {
  settlementId: string
  payoutId: string
  canResolve: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<null | "EXECUTED" | "FAILED">(null)
  const [reference, setReference] = useState("")
  const [verified, setVerified] = useState(false)
  const [reason, setReason] = useState("")
  const [key, renew] = useIdempotencyKey()
  const resolve = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/settlements/${settlementId}/payouts/${payoutId}/confirm`,
        {
          method: "POST",
          body:
            mode === "EXECUTED"
              ? {
                  outcome: "EXECUTED",
                  bankReference: reference,
                  executionVerified: verified,
                  idempotencyKey: key,
                }
              : { outcome: "FAILED", reason, idempotencyKey: key },
        }
      ),
    onSuccess: () => {
      renew()
      setMode(null)
      toast.success(
        mode === "EXECUTED"
          ? "Transferencia ejecutada"
          : "Transferencia marcada como no realizada"
      )
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo resolver")),
  })
  if (!canResolve) return null
  if (mode === null)
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-11 md:h-9"
          onClick={() => setMode("EXECUTED")}
          data-testid="transfer-execute"
        >
          Confirmar ejecución
        </Button>
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setMode("FAILED")}
          data-testid="transfer-fail"
        >
          No se realizó
        </Button>
      </div>
    )
  return (
    <div className="space-y-2 rounded-lg border p-3">
      {mode === "EXECUTED" ? (
        <>
          <Label htmlFor={`ref-${payoutId}`}>Referencia bancaria</Label>
          <Input
            id={`ref-${payoutId}`}
            className="h-11 md:h-9"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            data-testid="transfer-reference"
          />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
              data-testid="transfer-verified"
            />
            Verifiqué en el banco que la transferencia salió
          </label>
        </>
      ) : (
        <>
          <Label htmlFor={`reason-${payoutId}`}>¿Qué ocurrió?</Label>
          <Input
            id={`reason-${payoutId}`}
            className="h-11 md:h-9"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-11 md:h-9"
          disabled={
            resolve.isPending ||
            (mode === "EXECUTED"
              ? reference.trim().length < 2 || !verified
              : reason.trim().length < 5)
          }
          onClick={() => resolve.mutate()}
          data-testid="transfer-resolve-submit"
        >
          {resolve.isPending ? <Loader2 className="animate-spin" /> : null}
          Guardar
        </Button>
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setMode(null)}
          disabled={resolve.isPending}
        >
          Volver
        </Button>
      </div>
    </div>
  )
}

export function CancelSettlementButton({
  settlementId,
}: {
  settlementId: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const cancel = useMutation({
    mutationFn: () =>
      apiRequest(`/api/settlements/${settlementId}/cancel`, {
        method: "POST",
        body: { reason },
      }),
    onSuccess: () => {
      setOpen(false)
      toast.success("Liquidación cancelada")
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo cancelar")),
  })
  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => setOpen(true)}
        data-testid="cancel-settlement"
      >
        Cancelar liquidación
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !cancel.isPending && setOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar liquidación</AlertDialogTitle>
            <AlertDialogDescription>
              No hubo recepción de fichas ni pagos: no se revierte nada. La
              firma, si existía, se conserva como cancelada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Motivo</Label>
            <Input
              id="cancel-reason"
              className="h-11 md:h-9"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>
              Volver
            </AlertDialogCancel>
            <Button
              disabled={reason.trim().length < 5 || cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending ? <Loader2 className="animate-spin" /> : null}
              Cancelar liquidación
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function ReverseSettlementButton({
  settlementId,
  returned,
}: {
  settlementId: string
  returned: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [handedBack, setHandedBack] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const needsChips = returned !== "0.00"
  const reverse = useMutation({
    mutationFn: () =>
      apiRequest(`/api/settlements/${settlementId}/reverse`, {
        method: "POST",
        body: {
          reason,
          ...(needsChips ? { chipsHandedBack: handedBack } : {}),
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      setOpen(false)
      toast.success("Liquidación revertida")
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo revertir")),
  })
  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => setOpen(true)}
        data-testid="reverse-settlement"
      >
        Revertir liquidación
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !reverse.isPending && setOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revertir liquidación</AlertDialogTitle>
            <AlertDialogDescription>
              Solo sin pagos realizados. Se registran contraasientos: la deuda
              compensada vuelve, la cuenta por pagar y el comprobante se anulan.
              Nada se borra.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reverse-reason">Motivo</Label>
            <Input
              id="reverse-reason"
              className="h-11 md:h-9"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {needsChips ? (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={handedBack}
                  onChange={(e) => setHandedBack(e.target.checked)}
                />
                Regresé físicamente las fichas ({formatMXN(returned)}) al
                jugador
              </label>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverse.isPending}>
              Volver
            </AlertDialogCancel>
            <Button
              disabled={
                reason.trim().length < 10 ||
                (needsChips && !handedBack) ||
                reverse.isPending
              }
              onClick={() => reverse.mutate()}
            >
              {reverse.isPending ? <Loader2 className="animate-spin" /> : null}
              Revertir
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Aportación real de efectivo a la custodia de quien la recibe (pagos tras el cierre). */
export function CustodyContributionForm() {
  const router = useRouter()
  const [amount, setAmount] = useState("")
  const [from, setFrom] = useState("")
  const [reason, setReason] = useState("Pagar liquidaciones pendientes")
  const [received, setReceived] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const contribute = useMutation({
    mutationFn: () =>
      apiRequest("/api/credits/administrative/custody/contributions", {
        method: "POST",
        body: {
          amount,
          counterpartyName: from,
          reason,
          cashReceived: received,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      setAmount("")
      setReceived(false)
      toast.success("Aportación registrada en tu custodia")
      router.refresh()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo registrar")),
  })
  const ready =
    positive(amount) &&
    from.trim().length >= 2 &&
    reason.trim().length >= 5 &&
    received &&
    !contribute.isPending
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) contribute.mutate()
      }}
      data-testid="custody-contribution-form"
    >
      <div className="space-y-1">
        <Label htmlFor="contribAmount">Efectivo recibido</Label>
        <MoneyInput id="contribAmount" value={amount} onChange={setAmount} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="contribFrom">¿Quién lo entregó?</Label>
        <Input
          id="contribFrom"
          className="h-11 md:h-9"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="contribReason">Motivo</Label>
        <Input
          id="contribReason"
          className="h-11 md:h-9"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={received}
          onChange={(e) => setReceived(e.target.checked)}
        />
        Recibí físicamente este efectivo
      </label>
      <Button type="submit" className="h-11 w-full sm:w-auto" disabled={!ready}>
        {contribute.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar aportación
      </Button>
    </form>
  )
}
