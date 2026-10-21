"use client"

import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiClientError, apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  PurchaseSignaturePad,
  type PadStrokes,
} from "@/modules/signatures/components/purchase-signature-pad"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"

/**
 * Acciones del Módulo 16 (cliente). Solo CAPTURAN hechos declarados por el
 * operador (recepción física, pagos realizados, firma): el servidor
 * autoriza, valida, calcula importes, revalida estados y registra. Ningún
 * importe derivado (reembolso, compensación, saldo) se envía desde aquí.
 */

const API = "/api/special-operations"

function errorText(e: unknown) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : "No se pudo completar la operación"
}

function useAction() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run<T>(
    fn: () => Promise<T>,
    success: string,
    after?: (r: T) => void
  ) {
    setPending(true)
    setError(null)
    try {
      const r = await fn()
      toast.success(success)
      if (after) after(r)
      else router.refresh()
      return r
    } catch (e) {
      const msg = errorText(e)
      setError(msg)
      toast.error(msg)
      return null
    } finally {
      setPending(false)
    }
  }
  return { pending, error, setError, run, router }
}

export function TextArea(props: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 min-h-24 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm",
        props.className
      )}
    />
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
}

function Submit({
  pending,
  children,
  testId,
  variant,
  disabled,
}: {
  pending: boolean
  children: ReactNode
  testId: string
  variant?: "default" | "outline" | "destructive"
  disabled?: boolean
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || disabled}
      className="h-11 w-full sm:w-auto md:h-9"
      data-testid={testId}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  )
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p
      className="text-destructive text-sm"
      role="alert"
      data-testid="special-error"
    >
      {error}
    </p>
  ) : null
}

function Check({
  id,
  checked,
  onChange,
  children,
  testId,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
  testId: string
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-1 size-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span>{children}</span>
    </label>
  )
}

// ── 16.1 Canjes ─────────────────────────────────────────────────────

export function RedemptionCreateForm({
  players,
  sessions,
}: {
  players: { id: string; name: string }[]
  sessions: { id: string; folio: string }[]
}) {
  const { pending, error, run, router } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [presenterName, setPresenter] = useState("")
  const [playerId, setPlayerId] = useState("")
  const [originSessionId, setOrigin] = useState("")
  const [originEvidence, setEvidence] = useState("")
  const [presentedNominal, setPresented] = useState("")
  const [notes, setNotes] = useState("")
  return (
    <form
      className="space-y-3"
      data-testid="redemption-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest<{ id: string }>(`${API}/redemptions`, {
              method: "POST",
              body: {
                presenterName,
                presentedNominal,
                ...(playerId ? { playerId } : {}),
                ...(originSessionId ? { originSessionId, originEvidence } : {}),
                ...(notes ? { notes } : {}),
                idempotencyKey: key,
              },
            }),
          "Canje solicitado. No se recibieron fichas ni se movió dinero.",
          (r) => {
            renew()
            router.push(`${SPECIAL_BASE}/canjes/${r.id}`)
          }
        )
      }}
    >
      <Field id="r-presenter" label="¿Quién presenta las fichas?">
        <Input
          id="r-presenter"
          value={presenterName}
          onChange={(e) => setPresenter(e.target.value)}
          required
          data-testid="redemption-presenter"
        />
      </Field>
      <Field id="r-player" label="Jugador registrado (opcional)">
        <NativeSelect
          id="r-player"
          value={playerId}
          onChange={(e) => {
            setPlayerId(e.target.value)
            const p = players.find((x) => x.id === e.target.value)
            if (p && !presenterName) setPresenter(p.name)
          }}
          data-testid="redemption-player"
        >
          <option value="">Sin jugador registrado</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        id="r-amount"
        label="Valor nominal presentado"
        hint="Solo el valor total. El socio valida lo aceptado antes de recibir."
      >
        <Input
          id="r-amount"
          inputMode="decimal"
          value={presentedNominal}
          onChange={(e) => setPresented(e.target.value)}
          required
          data-testid="redemption-amount"
        />
      </Field>
      <Field
        id="r-origin"
        label="Sesión de origen (solo si se conoce con evidencia)"
        hint="Es informativa: la sesión, su caja y su cierre no cambian."
      >
        <NativeSelect
          id="r-origin"
          value={originSessionId}
          onChange={(e) => setOrigin(e.target.value)}
          data-testid="redemption-origin"
        >
          <option value="">Desconocida</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.folio}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {originSessionId ? (
        <Field id="r-evidence" label="Evidencia de la sesión de origen">
          <Input
            id="r-evidence"
            value={originEvidence}
            onChange={(e) => setEvidence(e.target.value)}
            required
            data-testid="redemption-origin-evidence"
          />
        </Field>
      ) : null}
      <Field id="r-notes" label="Notas (opcional)">
        <TextArea
          id="r-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <ErrorText error={error} />
      <Submit pending={pending} testId="submit-redemption">
        Registrar presentación
      </Submit>
    </form>
  )
}

export function RedemptionValidateForm({
  id,
  version,
  presented,
  denominations,
}: {
  id: string
  version: number
  presented: string
  denominations: { id: string; label: string; value: string }[]
}) {
  const { pending, error, run } = useAction()
  const [accepted, setAccepted] = useState(presented)
  const [notes, setNotes] = useState("")
  const [byDenom, setByDenom] = useState(false)
  const [qty, setQty] = useState<Record<string, string>>({})
  const list = byDenom
    ? denominations
        .map((d) => ({
          denominationId: d.id,
          quantity: Number(qty[d.id] || 0),
        }))
        .filter((d) => d.quantity > 0)
    : undefined
  return (
    <form
      className="space-y-3"
      data-testid="redemption-validate-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`${API}/redemptions/${id}/validate`, {
              method: "POST",
              body: {
                expectedVersion: version,
                acceptedNominal: accepted,
                ...(list && list.length > 0 ? { denominations: list } : {}),
                notes,
              },
            }),
          "Valor validado. Falta la recepción física."
        )
      }}
    >
      <Field
        id="v-accepted"
        label="Valor aceptado"
        hint="0 = rechazar el canje."
      >
        <Input
          id="v-accepted"
          inputMode="decimal"
          value={accepted}
          onChange={(e) => setAccepted(e.target.value)}
          required
          data-testid="redemption-accepted"
        />
      </Field>
      {denominations.length > 0 ? (
        <Check
          id="v-denoms"
          checked={byDenom}
          onChange={setByDenom}
          testId="redemption-by-denomination"
        >
          Registrar el conteo por denominación de las fichas presentadas
        </Check>
      ) : null}
      {byDenom ? (
        <ul className="grid grid-cols-2 gap-2">
          {denominations.map((d) => (
            <li key={d.id}>
              <Field id={`q-${d.id}`} label={d.label}>
                <Input
                  id={`q-${d.id}`}
                  inputMode="numeric"
                  value={qty[d.id] ?? ""}
                  onChange={(e) => setQty({ ...qty, [d.id]: e.target.value })}
                />
              </Field>
            </li>
          ))}
        </ul>
      ) : null}
      <Field id="v-notes" label="Motivo de la validación">
        <TextArea
          id="v-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          required
          data-testid="redemption-validation-notes"
        />
      </Field>
      <ErrorText error={error} />
      <Submit pending={pending} testId="submit-redemption-validation">
        Validar valor
      </Submit>
    </form>
  )
}

export function RedemptionReceiptForm({
  id,
  version,
  accepted,
}: {
  id: string
  version: number
  accepted: string
}) {
  const { pending, error, run } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [received, setReceived] = useState(false)
  return (
    <div className="space-y-3" data-testid="redemption-receipt-form">
      <Check
        id="rr-physical"
        checked={received}
        onChange={setReceived}
        testId="redemption-physical"
      >
        Recibí físicamente fichas por <strong>${accepted}</strong> y las guardé
        en el inventario compartido.
      </Check>
      <p className="text-muted-foreground text-xs">
        Firma de quien entrega las fichas (en este celular). La firma no paga:
        el pago se registra aparte.
      </p>
      <PurchaseSignaturePad
        pending={pending}
        disabled={!received}
        onConfirm={(strokes: PadStrokes) =>
          void run(
            () =>
              apiRequest(`${API}/redemptions/${id}/confirm-receipt`, {
                method: "POST",
                body: {
                  expectedVersion: version,
                  physicalReceiptConfirmed: true,
                  strokes,
                  idempotencyKey: key,
                },
              }),
            "Fichas recibidas. La obligación queda pendiente de pago.",
            () => {
              renew()
              location.reload()
            }
          )
        }
      />
      <ErrorText error={error} />
    </div>
  )
}

export function CancelForm({
  url,
  version,
  testId,
}: {
  url: string
  version: number
  testId: string
}) {
  const { pending, error, run } = useAction()
  const [reason, setReason] = useState("")
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(url, {
              method: "POST",
              body: { expectedVersion: version, reason },
            }),
          "Cancelado"
        )
      }}
    >
      <Field id={`${testId}-reason`} label="Motivo de la cancelación">
        <Input
          id={`${testId}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </Field>
      <ErrorText error={error} />
      <Submit pending={pending} testId={testId} variant="outline">
        Cancelar
      </Submit>
    </form>
  )
}

// ── Pagos (todas las obligaciones) ──────────────────────────────────

export function PayoutForm({
  payableId,
  available,
  sessionCashAllowed,
}: {
  payableId: string
  available: string
  sessionCashAllowed: boolean
}) {
  const { pending, error, run } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER">("CASH")
  const [funding, setFunding] = useState<"ADMIN_CUSTODY" | "SESSION_CASH">(
    "ADMIN_CUSTODY"
  )
  const [amount, setAmount] = useState(available)
  const [reference, setReference] = useState("")
  const [delivered, setDelivered] = useState(false)
  return (
    <form
      className="space-y-3"
      data-testid="payout-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`${API}/payables/${payableId}/payouts`, {
              method: "POST",
              body: {
                method,
                ...(method === "CASH" ? { funding } : {}),
                amount,
                ...(reference ? { bankReference: reference } : {}),
                idempotencyKey: key,
              },
            }),
          method === "CASH"
            ? "Pago en efectivo registrado."
            : "Transferencia en trámite: no cuenta como pagada hasta confirmarla.",
          () => {
            renew()
            setDelivered(false)
            location.reload()
          }
        )
      }}
    >
      <Field id="p-method" label="Método">
        <NativeSelect
          id="p-method"
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
          data-testid="payout-method"
        >
          <option value="CASH">Efectivo (se entrega ahora)</option>
          <option value="BANK_TRANSFER">
            Transferencia (queda en trámite)
          </option>
        </NativeSelect>
      </Field>
      {method === "CASH" ? (
        <Field
          id="p-funding"
          label="Origen del efectivo"
          hint="Nunca la caja de una sesión cerrada."
        >
          <NativeSelect
            id="p-funding"
            value={funding}
            onChange={(e) => setFunding(e.target.value as typeof funding)}
            data-testid="payout-funding"
          >
            <option value="ADMIN_CUSTODY">Mi custodia administrativa</option>
            {sessionCashAllowed ? (
              <option value="SESSION_CASH">
                Caja de la sesión de origen (abierta)
              </option>
            ) : null}
          </NativeSelect>
        </Field>
      ) : null}
      <Field id="p-amount" label={`Importe (disponible $${available})`}>
        <Input
          id="p-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          data-testid="payout-amount"
        />
      </Field>
      {method === "BANK_TRANSFER" ? (
        <Field id="p-ref" label="Referencia (opcional al registrar)">
          <Input
            id="p-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      ) : (
        <Check
          id="p-delivered"
          checked={delivered}
          onChange={setDelivered}
          testId="payout-delivered"
        >
          Entregué físicamente este efectivo al beneficiario.
        </Check>
      )}
      <ErrorText error={error} />
      <Submit
        pending={pending}
        testId="submit-payout"
        disabled={method === "CASH" && !delivered}
      >
        Registrar pago
      </Submit>
    </form>
  )
}

export function ResolvePayoutForm({ payoutId }: { payoutId: string }) {
  const { pending, error, run } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [outcome, setOutcome] = useState<"EXECUTED" | "FAILED" | "CANCELLED">(
    "EXECUTED"
  )
  const [reference, setReference] = useState("")
  const [reason, setReason] = useState("")
  return (
    <form
      className="space-y-2"
      data-testid={`resolve-payout-${payoutId}`}
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`${API}/payouts/${payoutId}/resolve`, {
              method: "POST",
              body: {
                outcome,
                ...(outcome === "EXECUTED"
                  ? { bankReference: reference }
                  : { reason }),
                idempotencyKey: key,
              },
            }),
          outcome === "EXECUTED"
            ? "Transferencia confirmada como realizada."
            : "Transferencia sin efecto.",
          () => {
            renew()
            location.reload()
          }
        )
      }}
    >
      <NativeSelect
        aria-label="Resultado de la transferencia"
        value={outcome}
        onChange={(e) => setOutcome(e.target.value as typeof outcome)}
        data-testid="resolve-outcome"
      >
        <option value="EXECUTED">Realizada (verificada en el banco)</option>
        <option value="FAILED">Fallida</option>
        <option value="CANCELLED">Cancelada</option>
      </NativeSelect>
      {outcome === "EXECUTED" ? (
        <Input
          aria-label="Referencia bancaria"
          placeholder="Referencia bancaria"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          required
          data-testid="resolve-reference"
        />
      ) : (
        <Input
          aria-label="Motivo"
          placeholder="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      )}
      <ErrorText error={error} />
      <Submit pending={pending} testId="submit-resolve" variant="outline">
        Confirmar resultado
      </Submit>
    </form>
  )
}

// ── 16.2 Reverso de compra ──────────────────────────────────────────

type ReversalPlan = {
  classification: string
  executable: boolean
  blockers: string[]
  effects: null | {
    chipsToReturn: string
    extinguish: string
    refund: string
    refundBreakdown: Record<string, string>
  }
}

export function PurchaseReversalForm({
  purchaseId,
  correctionId,
  version,
  nominal,
}: {
  purchaseId: string
  correctionId: string
  version: number
  nominal: string
}) {
  const { pending, error, run, router } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [returned, setReturned] = useState(false)
  const [amount, setAmount] = useState(nominal)
  const [reason, setReason] = useState("")
  const [plan, setPlan] = useState<ReversalPlan | null>(null)
  async function preview(confirmed: boolean, value: string) {
    try {
      const r = await apiRequest<{ plan: ReversalPlan }>(
        `${API}/purchase-reversals/${purchaseId}/preview`,
        {
          method: "POST",
          body: {
            physicalReturnConfirmed: confirmed,
            returnedNominal: value || "0",
          },
        }
      )
      setPlan(r.plan)
    } catch {
      setPlan(null)
    }
  }
  return (
    <form
      className="space-y-3"
      data-testid="purchase-reversal-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest<{ id: string }>(
              `${API}/purchase-reversals/${purchaseId}/execute`,
              {
                method: "POST",
                body: {
                  correctionId,
                  expectedVersion: version,
                  physicalReturnConfirmed: returned,
                  returnedNominal: amount || "0",
                  reason,
                  idempotencyKey: key,
                },
              }
            ),
          "Reverso ejecutado. El reembolso se paga aparte.",
          (r) => {
            renew()
            router.push(`${SPECIAL_BASE}/reversos-compras/${r.id}`)
          }
        )
      }}
    >
      <Check
        id="pr-returned"
        checked={returned}
        onChange={(v) => {
          setReturned(v)
          void preview(v, amount)
        }}
        testId="reversal-physical"
      >
        El jugador me devolvió físicamente las fichas de esta compra.
      </Check>
      <Field
        id="pr-amount"
        label={`Valor nominal devuelto (la compra entregó $${nominal})`}
      >
        <Input
          id="pr-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            void preview(returned, e.target.value)
          }}
          data-testid="reversal-returned"
        />
      </Field>
      {plan ? (
        <div
          className="rounded-md border p-3 text-sm"
          data-testid="reversal-plan"
          data-executable={plan.executable}
        >
          <p className="font-medium">
            {plan.executable ? "Ejecutable" : "Bloqueado"} ·{" "}
            {plan.classification}
          </p>
          {plan.effects ? (
            <ul className="mt-1 space-y-0.5 text-xs">
              <li>Fichas a recibir: ${plan.effects.chipsToReturn}</li>
              <li>
                Deuda que se extingue (sin dinero): ${plan.effects.extinguish}
              </li>
              <li>
                Reembolso de dinero realmente pagado: ${plan.effects.refund}
              </li>
            </ul>
          ) : null}
          {plan.blockers.length > 0 ? (
            <ul
              className="text-destructive mt-1 list-disc pl-4 text-xs"
              data-testid="reversal-blockers"
            >
              {plan.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Field id="pr-reason" label="Motivo">
        <TextArea
          id="pr-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          data-testid="reversal-reason"
        />
      </Field>
      <ErrorText error={error} />
      <Submit pending={pending} testId="submit-reversal">
        Ejecutar reverso
      </Submit>
    </form>
  )
}

// ── 16.3 Corrección de liquidación ──────────────────────────────────

type CorrectionPreview = {
  plan: {
    executable: boolean
    blockers: string[]
    effects: { amount: string; debtsRestored: string; newPayable: string }
  }
  declaration: string
}

export function SettlementCorrectionForm({
  settlementId,
  correctionId,
  version,
}: {
  settlementId: string
  correctionId: string
  version: number
}) {
  const { pending, error, run, router } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [kind, setKind] = useState<"OFFSET_REVERSAL" | "ADDITIONAL_PAYOUT">(
    "OFFSET_REVERSAL"
  )
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [preview, setPreview] = useState<CorrectionPreview | null>(null)
  const [reviewed, setReviewed] = useState(false)
  async function load() {
    setReviewed(false)
    try {
      setPreview(
        await apiRequest<CorrectionPreview>(
          `${API}/settlement-corrections/${settlementId}/preview`,
          {
            method: "POST",
            body: {
              kind,
              ...(kind === "ADDITIONAL_PAYOUT" && amount ? { amount } : {}),
            },
          }
        )
      )
    } catch (e) {
      toast.error(errorText(e))
      setPreview(null)
    }
  }
  return (
    <div className="space-y-3" data-testid="settlement-correction-form">
      <Field id="sc-kind" label="Tipo de corrección">
        <NativeSelect
          id="sc-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind)
            setPreview(null)
          }}
          data-testid="correction-kind"
        >
          <option value="OFFSET_REVERSAL">
            Revertir la compensación (las deudas regresan; se paga su valor)
          </option>
          <option value="ADDITIONAL_PAYOUT">
            Pago adicional que el negocio debe
          </option>
        </NativeSelect>
      </Field>
      {kind === "ADDITIONAL_PAYOUT" ? (
        <Field id="sc-amount" label="Importe adicional">
          <Input
            id="sc-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="correction-amount"
          />
        </Field>
      ) : null}
      <Field id="sc-reason" label="Motivo">
        <TextArea
          id="sc-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="correction-reason"
        />
      </Field>
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full sm:w-auto md:h-9"
        onClick={() => void load()}
        data-testid="correction-preview"
      >
        Preparar resumen para el jugador
      </Button>
      {preview ? (
        <div
          className="space-y-2 rounded-md border p-3 text-sm"
          data-testid="correction-summary"
          data-executable={preview.plan.executable}
        >
          <ul className="space-y-0.5 text-xs">
            <li>
              Deudas que se restablecen: ${preview.plan.effects.debtsRestored}
            </li>
            <li>
              Nuevo importe por pagar al jugador: $
              {preview.plan.effects.newPayable}
            </li>
            <li>Efectivo que se mueve ahora: $0.00</li>
          </ul>
          {preview.plan.blockers.length > 0 ? (
            <ul
              className="text-destructive list-disc pl-4 text-xs"
              data-testid="correction-blockers"
            >
              {preview.plan.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <>
              <p className="text-xs italic">«{preview.declaration}»</p>
              <Check
                id="sc-reviewed"
                checked={reviewed}
                onChange={setReviewed}
                testId="correction-reviewed"
              >
                El jugador revisó el resumen y acepta firmar.
              </Check>
              <PurchaseSignaturePad
                pending={pending}
                disabled={!reviewed}
                onConfirm={(strokes: PadStrokes) =>
                  void run(
                    () =>
                      apiRequest<{ id: string }>(
                        `${API}/settlement-corrections/${settlementId}/execute`,
                        {
                          method: "POST",
                          body: {
                            kind,
                            ...(kind === "ADDITIONAL_PAYOUT" ? { amount } : {}),
                            correctionId,
                            expectedVersion: version,
                            reason,
                            strokes,
                            idempotencyKey: key,
                          },
                        }
                      ),
                    "Corrección ejecutada. El nuevo importe queda pendiente de pago.",
                    (r) => {
                      renew()
                      router.push(
                        `${SPECIAL_BASE}/correcciones-liquidaciones/${r.id}`
                      )
                    }
                  )
                }
              />
            </>
          )}
        </div>
      ) : null}
      <ErrorText error={error} />
    </div>
  )
}

// ── 16.4 Fondos no aplicados ────────────────────────────────────────

export function UnappliedRefundForm({
  fundsId,
  correctionId,
}: {
  fundsId: string
  correctionId: string
}) {
  const { pending, error, run } = useAction()
  const [key, renew] = useIdempotencyKey()
  const [notes, setNotes] = useState("")
  return (
    <form
      className="space-y-3"
      data-testid="unapplied-refund-form"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () =>
            apiRequest(`${API}/unapplied-funds/${fundsId}/refunds`, {
              method: "POST",
              body: {
                correctionId,
                ...(notes ? { notes } : {}),
                idempotencyKey: key,
              },
            }),
          "Devolución registrada. Se paga con pagos reales.",
          () => {
            renew()
            location.reload()
          }
        )
      }}
    >
      <Field id="u-notes" label="Notas (opcional)">
        <Input
          id="u-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <ErrorText error={error} />
      <Submit pending={pending} testId="submit-unapplied-refund">
        Registrar devolución
      </Submit>
    </form>
  )
}
