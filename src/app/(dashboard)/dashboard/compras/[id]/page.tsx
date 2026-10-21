import { CircleAlert, CircleCheck, PenLine, ReceiptText } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import {
  AddPaymentForm,
  CancelPurchaseButton,
  ConfirmDeliveryForm,
  CreditAuthorizationForm,
  EditAmountForm,
  PaymentActions,
  PrepareDeliveryButton,
  ReversalRequestButton,
} from "@/modules/purchases/components/purchase-actions"
import {
  CHANNEL_LABEL,
  METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PURCHASES_BASE,
  PurchaseStatusBadge,
} from "@/modules/purchases/components/purchase-ui"
import { purchaseTypeLabel } from "@/modules/purchases/purchase.math"
import {
  getPurchase,
  getPurchaseAvailability,
  listCreditAuthorizers,
} from "@/modules/purchases/purchase.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Compra — Poker Manager" }

function Row({
  label,
  value,
  testId,
  strong,
}: {
  label: string
  value: string
  testId?: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn("tabular-nums", strong && "text-base font-semibold")}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  )
}

function Step({
  n,
  title,
  children,
  testId,
}: {
  n: number
  title: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="bg-muted flex size-6 items-center justify-center rounded-full text-xs">
            {n}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  )
}

export default async function PurchasePage({
  params,
}: PageProps<"/dashboard/compras/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASES_READ,
    PURCHASES_BASE
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const p = await getPurchase(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const canManage = can(user, PERMISSIONS.PURCHASES_CREATE)
  const canSign = can(user, PERMISSIONS.SIGNATURES_CAPTURE)
  const canSeeSignature = can(user, PERMISSIONS.SIGNATURES_READ)
  const editable =
    canManage &&
    (p.status === "DRAFT" || p.status === "READY_FOR_DELIVERY") &&
    p.session.status === "OPEN"
  const [availability, partners] = await Promise.all([
    getPurchaseAvailability(),
    editable ? listCreditAuthorizers() : Promise.resolve([]),
  ])
  const f = p.financials
  const hasCredit = f.outstanding !== "0.00"

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <BackLink href={PURCHASES_BASE} label="Compras" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          Compra <span className="font-mono">{p.folio}</span>
        </h1>
        <PurchaseStatusBadge status={p.status} />
      </div>

      <Step n={1} title="Jugador y mesa">
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-muted-foreground text-xs">Jugador</dt>
            <dd className="font-medium" data-testid="purchase-player">
              {p.player.name}
              {p.player.nickname ? ` · ${p.player.nickname}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Mesa de origen</dt>
            <dd data-testid="purchase-table">
              <Link
                className="underline-offset-4 hover:underline"
                href={`${SESSIONS_BASE}/${p.session.id}/mesas/${p.table.id}`}
              >
                {p.table.name}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Tipo</dt>
            <dd data-testid="purchase-kind">
              {p.status === "CONFIRMED"
                ? purchaseTypeLabel(p.purchaseType, p.rebuyNumber)
                : "Se asigna al confirmar"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Sesión</dt>
            <dd className="font-mono">{p.session.folio}</dd>
          </div>
        </dl>
        {p.participation.status !== "ACTIVE" && p.status !== "CONFIRMED" ? (
          <p className="rounded-lg border border-amber-500/50 p-3" role="alert">
            El jugador ya no está activo en esta mesa (se cambió de mesa o se
            retiró). Esta compra conserva su mesa original: cancélala y registra
            una nueva en la mesa actual.
          </p>
        ) : null}
      </Step>

      <Step n={2} title="Importe solicitado">
        <p
          className="text-3xl font-semibold tabular-nums"
          data-testid="purchase-amount"
        >
          {formatMXN(p.nominalAmount)}
        </p>
        <p className="text-muted-foreground text-xs">
          Solo importe: el cajero elige la combinación de fichas al entregar.
        </p>
        {editable ? (
          <EditAmountForm
            purchaseId={p.id}
            version={p.version}
            current={p.nominalAmount}
          />
        ) : null}
      </Step>

      <Step n={3} title="Pagos" testId="payments-step">
        <dl className="divide-y" data-testid="purchase-financials">
          <Row label="Importe solicitado" value={formatMXN(f.nominalAmount)} />
          <Row
            label="Pagos confirmados"
            value={formatMXN(f.confirmedPayments)}
            testId="confirmed-payments"
          />
          <Row
            label="Transferencias pendientes"
            value={formatMXN(f.pendingTransfers)}
            testId="pending-transfers"
          />
          {f.pendingCards !== "0.00" ? (
            <Row
              label="Terminal en proceso"
              value={formatMXN(f.pendingCards)}
            />
          ) : null}
          <Row
            label="Crédito sin pago asignado"
            value={formatMXN(f.uncoveredCredit)}
            testId="uncovered-credit"
          />
          <Row label="Total aplicado" value={formatMXN(f.committedPayments)} />
          <Row
            label="Importe aún por cobrar"
            value={formatMXN(f.outstanding)}
            testId="outstanding"
            strong
          />
        </dl>
        {p.payments.length ? (
          <ul className="space-y-2" data-testid="payment-list">
            {p.payments.map((pay) => (
              <li
                key={pay.id}
                className="space-y-2 rounded-lg border p-3"
                data-testid="payment-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {METHOD_LABEL[pay.method]} · {formatMXN(pay.amount)}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      pay.effect === "CONFIRMED" &&
                        "text-emerald-700 dark:text-emerald-400",
                      pay.effect === "VOID" && "text-muted-foreground"
                    )}
                    data-testid="payment-status"
                  >
                    {pay.method === "BANK_TRANSFER"
                      ? pay.status === "CANCELLED"
                        ? "Retirada"
                        : pay.bankTransfer?.status === "CONFIRMED"
                          ? `Verificada${pay.bankTransfer.confirmedAmount && pay.bankTransfer.confirmedAmount !== pay.amount ? ` por ${formatMXN(pay.bankTransfer.confirmedAmount)}` : ""}`
                          : pay.bankTransfer?.status === "REJECTED"
                            ? "Rechazada en banco"
                            : "Pendiente de verificación"
                      : PAYMENT_STATUS_LABEL[pay.status]}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {pay.terminalReference
                    ? `Terminal: ${pay.terminalReference} · `
                    : ""}
                  {pay.externalReference
                    ? `Ref.: ${pay.externalReference} · `
                    : ""}
                  {pay.createdBy.name} · {formatDateTime(pay.createdAt)}
                  {pay.financialTransaction
                    ? ` · Movimiento ${pay.financialTransaction.folio}`
                    : ""}
                </p>
                {editable ? (
                  <div className="flex flex-wrap gap-2">
                    <PaymentActions
                      purchaseId={p.id}
                      payment={{
                        id: pay.id,
                        method: pay.method,
                        status: pay.status,
                        effect: pay.effect,
                        bankTransferStatus: pay.bankTransfer?.status ?? null,
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Aún no hay pagos.</p>
        )}
        {editable ? (
          <AddPaymentForm purchaseId={p.id} suggested={f.uncoveredCredit} />
        ) : null}
      </Step>

      {hasCredit || p.creditAuthorization || p.debt ? (
        <Step n={4} title="Crédito y socio autorizador" testId="credit-step">
          <p>
            Saldo a crédito:{" "}
            <strong data-testid="credit-amount">
              {formatMXN(p.debt ? p.debt.originalAmount : f.outstanding)}
            </strong>
            {f.pendingTransfers !== "0.00"
              ? ` (incluye ${formatMXN(f.pendingTransfers)} de transferencias pendientes)`
              : ""}
          </p>
          {p.creditAuthorization ? (
            <p data-testid="credit-authorizer">
              Autorizó <strong>{p.creditAuthorization.partnerName}</strong> (
              {CHANNEL_LABEL[p.creditAuthorization.channel].toLowerCase()}) ·
              registró {p.creditAuthorization.recordedBy.name},{" "}
              {formatDateTime(p.creditAuthorization.recordedAt)}
            </p>
          ) : p.status === "CONFIRMED" && p.authorizationHistory[0] ? (
            <p data-testid="credit-authorizer">
              Autorizó <strong>{p.authorizationHistory[0].partnerName}</strong>{" "}
              ({CHANNEL_LABEL[p.authorizationHistory[0].channel].toLowerCase()})
            </p>
          ) : null}
          {editable && hasCredit ? (
            <CreditAuthorizationForm purchaseId={p.id} partners={partners} />
          ) : null}
          {p.debt ? (
            <p className="text-muted-foreground text-xs">
              Deuda generada: {formatMXN(p.debt.originalAmount)} · saldo vigente
              (derivado): {formatMXN(p.debt.currentBalance)}
            </p>
          ) : null}
        </Step>
      ) : null}

      {hasCredit || p.signature.signatureId || p.signatures.length ? (
        <Step n={5} title="Firma del jugador" testId="signature-step">
          {p.signature.present ? (
            <div className="space-y-2">
              <p
                className="flex items-center gap-2"
                data-testid="signature-present"
              >
                <CircleCheck className="size-4 text-emerald-600" aria-hidden />
                Firma registrada para esta versión de la compra.
              </p>
              {canSeeSignature ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/purchases/${p.id}/signature-evidence`}
                  alt="Firma del jugador"
                  className="aspect-[5/2] w-full max-w-sm rounded-lg border bg-white"
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <p
                className="flex items-start gap-2"
                data-testid="signature-required"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden
                />
                {p.creditAuthorization
                  ? "El jugador debe firmar el reconocimiento de esta compra en este dispositivo antes de la entrega."
                  : "Primero registra al socio que autorizó el crédito; después el jugador firma."}
              </p>
              {editable && p.creditAuthorization && canSign ? (
                <Link
                  href={`${PURCHASES_BASE}/${p.id}/firma`}
                  className={cn(buttonVariants(), "h-11 w-full sm:w-auto")}
                  data-testid="go-sign"
                >
                  <PenLine />
                  Capturar firma del jugador
                </Link>
              ) : null}
            </div>
          )}
          {p.signatures.some((x) => x.status !== "VALID") ? (
            <ul
              className="text-muted-foreground space-y-1 text-xs"
              data-testid="signature-history"
            >
              {p.signatures
                .filter((x) => x.status !== "VALID")
                .map((x) => (
                  <li key={x.id}>
                    {x.status === "CANCELLED" ? "Cancelada" : "Invalidada"} ·
                    firmada {formatDateTime(x.signedAt)} ·{" "}
                    {x.invalidationReason} (se conserva como evidencia)
                  </li>
                ))}
            </ul>
          ) : null}
        </Step>
      ) : null}

      <Step
        n={hasCredit ? 6 : 4}
        title="Confirmación de entrega"
        testId="delivery-step"
      >
        {p.status === "CONFIRMED" && p.delivery ? (
          <div className="space-y-1" data-testid="delivery-done">
            <p>
              Entregada por {p.delivery.deliveredBy.name} el{" "}
              {formatDateTime(p.delivery.deliveredAt)}.
            </p>
            <p className="text-muted-foreground text-xs">
              Salida nominal de {formatMXN(p.delivery.nominalAmount)} del
              inventario compartido.
            </p>
            <Link
              href={`${PURCHASES_BASE}/${p.id}/comprobante`}
              className={cn(buttonVariants(), "mt-2 h-11 w-full sm:w-auto")}
              data-testid="go-receipt"
            >
              <ReceiptText />
              Ver comprobante
            </Link>
          </div>
        ) : p.status === "CANCELLED" ? (
          <p>
            Cancelada por {p.cancelledBy?.name} ·{" "}
            {p.cancelledAt ? formatDateTime(p.cancelledAt) : ""} ·{" "}
            {p.cancellationReason}
          </p>
        ) : (
          <>
            <dl className="divide-y">
              <Row label="Jugador" value={p.player.name} />
              <Row label="Mesa" value={p.table.name} />
              <Row label="Importe" value={formatMXN(p.nominalAmount)} />
              <Row
                label="Pagos realmente confirmados"
                value={formatMXN(f.confirmedPayments)}
              />
              <Row label="Pendiente" value={formatMXN(f.outstanding)} />
              <Row
                label="Socio autorizador"
                value={p.creditAuthorization?.partnerName ?? "—"}
              />
              <Row
                label="Firma"
                value={
                  !hasCredit
                    ? "No requerida (pagada)"
                    : p.signature.present
                      ? "Registrada"
                      : "Pendiente"
                }
              />
              <Row
                label="Saldo nominal disponible"
                value={formatMXN(availability.available)}
                testId="nominal-available"
              />
            </dl>
            {p.blockers.length ? (
              <ul className="space-y-1" data-testid="delivery-blockers">
                {p.blockers.map((b) => (
                  <li key={b.code} className="flex items-start gap-2">
                    <CircleAlert
                      className="mt-0.5 size-4 shrink-0 text-amber-600"
                      aria-hidden
                    />
                    {b.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {editable ? (
              <>
                {p.reservationActive ? (
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="reservation-active"
                  >
                    Fichas apartadas en el inventario compartido (15 minutos).
                  </p>
                ) : (
                  <PrepareDeliveryButton purchaseId={p.id} />
                )}
                <ConfirmDeliveryForm
                  purchaseId={p.id}
                  version={p.version}
                  blocked={p.blockers.length > 0}
                />
              </>
            ) : null}
          </>
        )}
      </Step>

      {p.reversalRequests.length ? (
        <Card>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">Solicitud de reverso</p>
            {p.reversalRequests.map((r) => (
              <p key={r.id} className="text-muted-foreground text-xs">
                {r.requestedBy.name} · {formatDateTime(r.requestedAt)} ·{" "}
                {r.reason} · Pendiente (requiere devolución física y resolución
                financiera).
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {editable ? <CancelPurchaseButton purchaseId={p.id} /> : null}
        {canManage &&
        p.status === "CONFIRMED" &&
        p.reversalRequests.length === 0 ? (
          <ReversalRequestButton purchaseId={p.id} />
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Registró {p.createdBy.name} · {formatDateTime(p.createdAt)}
        {p.confirmedBy
          ? ` · Confirmó ${p.confirmedBy.name} · ${p.confirmedAt ? formatDateTime(p.confirmedAt) : ""}`
          : ""}
      </p>
    </div>
  )
}
