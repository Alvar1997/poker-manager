"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import {
  AddPaymentForm,
  CancelPurchaseButton,
  ConfirmDeliveryForm,
  CreditAuthorizationForm,
  PaymentActions,
} from "@/modules/purchases/components/purchase-actions"
import type { PurchaseView } from "@/modules/purchases/purchase.service"
import { SignatureCapture } from "@/modules/signatures/components/signature-actions"
import type { SignatureSummaryView } from "@/modules/signatures/signature.service"
import { QUICK_BUY_AMOUNTS } from "@/modules/table-floor/table-floor.math"

import { errorText, type Occupant } from "./use-table-board"

const MONEY = /^\d{1,10}(\.\d{1,2})?$/
const positive = (v: string) => MONEY.test(v) && /[1-9]/.test(v)

type QuickMethod =
  "CASH" | "BANK_TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT" | "CREDIT" | "MIXED"

const METHODS: { value: QuickMethod; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "BANK_TRANSFER", label: "Transferencia" },
  { value: "CARD_DEBIT", label: "Terminal débito" },
  { value: "CARD_CREDIT", label: "Terminal crédito" },
  { value: "CREDIT", label: "Crédito" },
  { value: "MIXED", label: "Pago mixto" },
]

/** Modalidad que se guarda en la compra (el servidor valida los cobros). */
const MODE_OF: Record<QuickMethod, string> = {
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  CARD_DEBIT: "CARD",
  CARD_CREDIT: "CARD",
  CREDIT: "CREDIT",
  MIXED: "MIXED",
}

const METHOD_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD_DEBIT: "Terminal débito",
  CARD_CREDIT: "Terminal crédito",
}

const MODE_LABEL: Record<string, string> = {
  CASH: "Efectivo",
  BANK_TRANSFER: "Transferencia",
  CARD: "Terminal",
  CREDIT: "Crédito total",
  MIXED: "Pago mixto",
}

export function purchaseKindLabel(o: Pick<Occupant, "nextPurchase">) {
  return o.nextPurchase.purchaseType === "INITIAL_PURCHASE"
    ? "Compra inicial"
    : `Recompra ${o.nextPurchase.rebuyNumber}`
}

/**
 * Compra inicial / recompra desde el asiento. NO es un atajo: usa los
 * mismos endpoints del Módulo 08 (borrador → pagos → socio → firma del
 * Módulo 09 → confirmación física) y el servidor decide el tipo y el
 * número al confirmar la entrega. El paso visible lo marcan los bloqueos
 * que devuelve el servidor, nunca un estado local.
 */
export function QuickPurchaseSheet({
  open,
  onOpenChange,
  occupant,
  tableName,
  canSign,
  partners,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  occupant: Occupant
  tableName: string
  canSign: boolean
  partners: { id: string; name: string }[]
  onChanged: () => void
}) {
  const [purchaseId, setPurchaseId] = useState<string | null>(
    occupant.pendingPurchase?.id ?? null
  )
  const kind = purchaseKindLabel(occupant)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="quick-purchase-sheet">
        <SheetHeader>
          <SheetTitle data-testid="quick-purchase-kind">{kind}</SheetTitle>
          <SheetDescription>
            {occupant.player.name} · {tableName} · asiento{" "}
            {occupant.seatNumber ?? "—"}
          </SheetDescription>
        </SheetHeader>
        {purchaseId ? (
          <PurchaseProgress
            purchaseId={purchaseId}
            canSign={canSign}
            partners={partners}
            onChanged={onChanged}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <QuickPurchaseForm
            occupant={occupant}
            onCreated={(id) => {
              setPurchaseId(id)
              onChanged()
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Alias con los nombres del rediseño: el servidor decide el tipo real. */
export const QuickBuyInSheet = QuickPurchaseSheet
export const QuickRebuySheet = QuickPurchaseSheet

function QuickPurchaseForm({
  occupant,
  onCreated,
}: {
  occupant: Occupant
  onCreated: (purchaseId: string) => void
}) {
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<QuickMethod>("CASH")
  const [received, setReceived] = useState(false)
  const [reference, setReference] = useState("")
  const [approved, setApproved] = useState(false)
  const [draftKey] = useIdempotencyKey()
  const [paymentKey] = useIdempotencyKey()
  const isCard = method === "CARD_DEBIT" || method === "CARD_CREDIT"
  const available = useQuery({
    queryKey: ["purchase-availability"],
    queryFn: () =>
      apiRequest<{ available: string }>("/api/purchases/availability"),
  })
  const create = useMutation({
    mutationFn: async () => {
      const draft = await apiRequest<{ id: string }>("/api/purchases", {
        method: "POST",
        body: {
          participationId: occupant.participationId,
          nominalAmount: amount,
          paymentMode: MODE_OF[method],
          idempotencyKey: draftKey,
        },
      })
      // El borrador ya existe: si el pago falla, se continúa desde la compra.
      try {
        if (method === "CASH")
          await apiRequest(`/api/purchases/${draft.id}/payments`, {
            method: "POST",
            body: {
              method,
              amount,
              cashReceived: received,
              idempotencyKey: paymentKey,
            },
          })
        else if (method === "BANK_TRANSFER")
          await apiRequest(`/api/purchases/${draft.id}/payments`, {
            method: "POST",
            body: {
              method,
              amount,
              ...(reference.trim() ? { bankReference: reference.trim() } : {}),
              idempotencyKey: paymentKey,
            },
          })
        else if (isCard)
          await apiRequest(`/api/purchases/${draft.id}/payments`, {
            method: "POST",
            body: {
              method,
              amount,
              result: "APPROVED",
              terminalReference: reference.trim(),
              approvalConfirmed: approved,
              idempotencyKey: paymentKey,
            },
          })
      } catch (e) {
        toast.error(errorText(e, "No se pudo registrar el pago"))
      }
      return draft
    },
    onSuccess: (d) => onCreated(d.id),
    onError: (e) => toast.error(errorText(e, "No se pudo iniciar la compra")),
  })
  const valid =
    positive(amount) &&
    (method !== "CASH" || received) &&
    (!isCard || (approved && reference.trim().length >= 2))
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !create.isPending) create.mutate()
      }}
      data-testid="quick-purchase-form"
    >
      <section className="space-y-2">
        <p className="text-sm font-medium">Importe</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {QUICK_BUY_AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAmount(a)}
              aria-pressed={amount === a}
              className={cn(
                "h-12 rounded-xl border text-base font-semibold tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-sky-400",
                amount === a
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              )}
              data-testid={`quick-amount-${Number(a)}`}
            >
              {formatMXN(a).replace(/\.00$/, "")}
            </button>
          ))}
        </div>
        <div className="relative">
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg">
            $
          </span>
          <Input
            aria-label="Otro importe"
            placeholder="Otro importe"
            inputMode="decimal"
            autoComplete="off"
            className="h-12 pl-7 text-lg font-semibold tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            aria-invalid={amount !== "" && !MONEY.test(amount)}
            data-testid="quick-amount-custom"
          />
        </div>
        <p
          className="text-muted-foreground text-xs"
          data-testid="quick-available"
        >
          Sugerencias, no límites. Disponible en el inventario compartido:{" "}
          {available.data ? formatMXN(available.data.available) : "…"}.
        </p>
      </section>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Método de pago</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {METHODS.map((m) => (
            <label
              key={m.value}
              className={cn(
                "flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm",
                method === m.value && "border-primary bg-primary/5 font-medium"
              )}
            >
              <input
                type="radio"
                name="quick-method"
                className="size-4"
                value={m.value}
                checked={method === m.value}
                onChange={() => {
                  setMethod(m.value)
                  setReceived(false)
                  setApproved(false)
                  setReference("")
                }}
                data-testid={`quick-method-${m.value}`}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>

      {method === "CASH" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={received}
            onChange={(e) => setReceived(e.target.checked)}
            data-testid="quick-cash-received"
          />
          Recibí físicamente este efectivo
        </label>
      ) : method === "BANK_TRANSFER" ? (
        <div className="space-y-1">
          <Label htmlFor="quick-ref">Referencia (opcional)</Label>
          <Input
            id="quick-ref"
            className="h-11"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Queda <strong>pendiente</strong> hasta verificarla en el banco: no
            cuenta como cobrada y, mientras tanto, la diferencia es crédito
            (requiere socio y firma).
          </p>
        </div>
      ) : isCard ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="quick-terminal-ref">
              Folio o autorización de la terminal
            </Label>
            <Input
              id="quick-terminal-ref"
              className="h-11"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              Nunca captures el número de la tarjeta, CVV ni NIP. Si la terminal
              rechazó o sigue en proceso, usa «Pago mixto».
            </p>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              data-testid="quick-card-approved"
            />
            La terminal mostró el cobro como APROBADO
          </label>
        </div>
      ) : method === "CREDIT" ? (
        <p className="rounded-xl border p-3 text-sm">
          Todo el importe queda <strong>a crédito</strong>: después registras al
          socio que lo autorizó y el jugador firma en este celular.
        </p>
      ) : (
        <p className="rounded-xl border p-3 text-sm">
          Agregarás cada pago (efectivo, transferencia o terminal) en el
          siguiente paso. Lo que falte queda a crédito.
        </p>
      )}

      {positive(amount) ? (
        <dl
          className="bg-muted/50 divide-y rounded-xl p-3 text-sm"
          data-testid="quick-summary"
        >
          <div className="flex justify-between py-1">
            <dt>Importe</dt>
            <dd className="font-semibold tabular-nums">{formatMXN(amount)}</dd>
          </div>
          <div className="flex justify-between py-1">
            <dt>A crédito (estimado)</dt>
            <dd className="tabular-nums">
              {method === "CREDIT" || method === "BANK_TRANSFER"
                ? formatMXN(amount)
                : method === "MIXED"
                  ? "según los pagos"
                  : formatMXN("0")}
            </dd>
          </div>
        </dl>
      ) : null}

      <Button
        type="submit"
        className="h-12 w-full text-base"
        disabled={!valid || create.isPending}
        data-testid="quick-purchase-continue"
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : null}
        Continuar
      </Button>
    </form>
  )
}

/** Estado REAL de la compra (servidor) y el siguiente paso. */
function PurchaseProgress({
  purchaseId,
  canSign,
  partners,
  onChanged,
  onClose,
}: {
  purchaseId: string
  canSign: boolean
  partners: { id: string; name: string }[]
  onChanged: () => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const purchase = useQuery({
    queryKey: ["purchase", purchaseId],
    queryFn: () => apiRequest<PurchaseView>(`/api/purchases/${purchaseId}`),
  })
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["purchase", purchaseId] })
    await qc.invalidateQueries({ queryKey: ["purchase-signature", purchaseId] })
    onChanged()
  }
  if (purchase.isLoading)
    return <p className="text-muted-foreground text-sm">Cargando compra…</p>
  if (purchase.isError || !purchase.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(purchase.error, "No se pudo cargar la compra")}
      </p>
    )
  const p = purchase.data
  if (p.status === "CONFIRMED")
    return (
      <div className="space-y-3" data-testid="quick-purchase-done">
        <p className="flex items-center gap-2 rounded-xl border p-3 text-sm font-medium">
          <CircleCheck className="size-5 text-emerald-600" aria-hidden />
          Entrega confirmada:{" "}
          {p.purchaseType === "INITIAL_PURCHASE"
            ? "compra inicial"
            : `recompra ${p.rebuyNumber}`}{" "}
          {p.folio} por {formatMXN(p.nominalAmount)}.
        </p>
        <Link
          href={`/dashboard/compras/${p.id}/comprobante`}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full")}
        >
          Ver comprobante
        </Link>
        <Button
          className="h-12 w-full"
          onClick={onClose}
          data-testid="quick-purchase-close"
        >
          Volver a la mesa
        </Button>
      </div>
    )
  if (p.status !== "DRAFT" && p.status !== "READY_FOR_DELIVERY")
    return (
      <div className="space-y-3">
        <p className="rounded-xl border p-3 text-sm">
          La compra {p.folio} ya no está en preparación.
        </p>
        <Button className="h-12 w-full" onClick={onClose}>
          Volver a la mesa
        </Button>
      </div>
    )
  const blocker = p.blockers[0]?.code ?? null
  const outstanding = p.financials.outstanding
  return (
    <div className="space-y-4">
      <dl
        className="bg-muted/50 divide-y rounded-xl p-3 text-sm"
        data-testid="purchase-progress"
        data-payment-mode={p.paymentMode ?? "NONE"}
      >
        {p.paymentMode ? (
          <div className="flex justify-between py-1">
            <dt>Forma de pago</dt>
            <dd data-testid="progress-mode">{MODE_LABEL[p.paymentMode]}</dd>
          </div>
        ) : null}
        <div className="flex justify-between py-1">
          <dt>Compra {p.folio}</dt>
          <dd className="font-semibold tabular-nums">
            {formatMXN(p.nominalAmount)}
          </dd>
        </div>
        {p.payments.map((x) => (
          <div key={x.id} className="space-y-1 py-1">
            <div className="flex justify-between gap-2">
              <dt>
                · {METHOD_LABEL[x.method] ?? x.method}
                <span className="text-muted-foreground text-xs">
                  {" "}
                  (
                  {x.effect === "CONFIRMED"
                    ? "cobrado"
                    : x.effect === "PENDING"
                      ? "pendiente"
                      : "anulado"}
                  )
                </span>
              </dt>
              <dd className="tabular-nums">{formatMXN(x.amount)}</dd>
            </div>
            <PaymentActions
              purchaseId={p.id}
              payment={{
                id: x.id,
                method: x.method,
                status: x.status,
                effect: x.effect,
                bankTransferStatus: x.bankTransfer?.status ?? null,
              }}
            />
          </div>
        ))}
        <div className="flex justify-between py-1">
          <dt>Cobrado</dt>
          <dd className="tabular-nums">
            {formatMXN(p.financials.confirmedPayments)}
          </dd>
        </div>
        <div className="flex justify-between py-1 font-semibold">
          <dt>Saldo a crédito</dt>
          <dd className="tabular-nums" data-testid="progress-credit">
            {formatMXN(outstanding)}
          </dd>
        </div>
      </dl>

      {/* Solo PAGO MIXTO (o compras anteriores sin modalidad) agrega componentes;
          un CRÉDITO TOTAL nunca muestra campos de efectivo. */}
      {outstanding !== "0.00" &&
      (p.paymentMode === null ||
        p.paymentMode === "MIXED" ||
        (p.paymentMode !== "CREDIT" &&
          !p.payments.some((x) => x.effect !== "VOID"))) ? (
        <AddPaymentToggle
          purchaseId={p.id}
          suggested={outstanding}
          initiallyOpen={p.payments.length === 0}
          onDone={refresh}
        />
      ) : null}

      {blocker === "PENDING_CARD_PAYMENT" || blocker === "OVER_APPLIED" ? (
        <p
          className="flex items-start gap-2 rounded-xl border p-3 text-sm"
          role="alert"
        >
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600"
            aria-hidden
          />
          {p.blockers[0].message}
        </p>
      ) : blocker === "CREDIT_AUTHORIZATION_REQUIRED" ? (
        <section className="space-y-2">
          <p className="text-sm font-medium">Socio que autorizó el crédito</p>
          <CreditAuthorizationForm
            purchaseId={p.id}
            partners={partners}
            onDone={refresh}
          />
        </section>
      ) : blocker === "CREDIT_SIGNATURE_REQUIRED" ? (
        canSign ? (
          <PurchaseSignatureStep purchaseId={p.id} onDone={refresh} />
        ) : (
          <p className="rounded-xl border p-3 text-sm" role="alert">
            Falta la firma del jugador y tu rol no puede capturarla.
          </p>
        )
      ) : blocker === "PARTICIPATION_NOT_ACTIVE" ||
        blocker === "PURCHASE_NOT_EDITABLE" ? (
        <p className="rounded-xl border p-3 text-sm" role="alert">
          {p.blockers[0].message}
        </p>
      ) : (
        <section className="space-y-2">
          <p className="text-sm font-medium">Entrega física</p>
          <ConfirmDeliveryForm
            purchaseId={p.id}
            version={p.version}
            blocked={false}
            onDone={refresh}
          />
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <CancelPurchaseButton
          purchaseId={p.id}
          onDone={async () => {
            await refresh()
            onClose()
          }}
        />
        <Link
          href={`/dashboard/compras/${p.id}`}
          className={cn(buttonVariants({ variant: "ghost" }), "h-11")}
        >
          Abrir compra completa
        </Link>
      </div>
    </div>
  )
}

function AddPaymentToggle({
  purchaseId,
  suggested,
  initiallyOpen,
  onDone,
}: {
  purchaseId: string
  suggested: string
  initiallyOpen: boolean
  onDone: () => void
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="rounded-xl border p-3">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="toggle-add-payment"
      >
        Agregar un pago (efectivo, transferencia o terminal)
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="pt-3">
          <AddPaymentForm
            purchaseId={purchaseId}
            suggested={suggested}
            onDone={onDone}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Paso de firma: el servidor prepara el reconocimiento exacto; el jugador firma aquí. */
function PurchaseSignatureStep({
  purchaseId,
  onDone,
}: {
  purchaseId: string
  onDone: () => void
}) {
  const prepared = useQuery({
    queryKey: ["purchase-signature", purchaseId],
    queryFn: () =>
      apiRequest<{ summary: SignatureSummaryView }>(
        `/api/purchases/${purchaseId}/signature-summary`,
        { method: "POST" }
      ),
    staleTime: Infinity,
    retry: false,
  })
  if (prepared.isLoading)
    return (
      <p className="text-muted-foreground text-sm">Preparando el resumen…</p>
    )
  if (prepared.isError || !prepared.data)
    return (
      <p className="text-destructive text-sm" role="alert">
        {errorText(prepared.error, "No se pudo preparar la firma")}
      </p>
    )
  const s = prepared.data.summary
  return (
    <section className="space-y-3" data-testid="quick-signature-step">
      <p className="text-sm font-medium">Firma del jugador</p>
      <dl className="divide-y rounded-xl border p-3 text-sm">
        <div className="flex justify-between py-1">
          <dt>Importe</dt>
          <dd className="tabular-nums">{formatMXN(s.nominalAmount)}</dd>
        </div>
        <div className="flex justify-between py-1 font-semibold">
          <dt>Saldo a crédito</dt>
          <dd className="tabular-nums">
            {formatMXN(s.outstandingCreditAmount)}
          </dd>
        </div>
        <div className="flex justify-between py-1">
          <dt>Autorizó</dt>
          <dd>{s.partnerName}</dd>
        </div>
      </dl>
      <blockquote className="bg-muted rounded-xl p-3 text-sm leading-relaxed">
        {s.declarationText}
      </blockquote>
      <SignatureCapture
        purchaseId={purchaseId}
        snapshotId={s.snapshotId}
        payloadHash={s.payloadHash}
        onDone={onDone}
      />
    </section>
  )
}
