import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { custodyBalanceOf } from "@/modules/credits/custody.service"
import {
  RegisterPayoutForm,
  ResolveTransferActions,
} from "@/modules/settlements/components/settlement-actions"
import {
  AmountRow,
  PAYOUT_FUNDING_LABEL,
  PAYOUT_STATUS_LABEL,
  SETTLEMENTS_BASE,
  SettlementStatusBadge,
} from "@/modules/settlements/components/settlement-ui"
import { sessionCashAvailable } from "@/modules/settlements/settlement.service"

import { BackLink } from "../../../sesiones/back-link"
import { loadSettlement } from "../load-settlement"

export const metadata = { title: "Pagos de liquidación — Poker Manager" }

export default async function SettlementPayoutsPage({
  params,
}: PageProps<"/dashboard/liquidaciones/[id]/pagos">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SETTLEMENTS_READ,
    SETTLEMENTS_BASE
  )
  const s = await loadSettlement(id)
  const sessionCash =
    s.session.status === "OPEN" || s.session.status === "CLOSING"
  const cashAvailable = sessionCash
    ? await sessionCashAvailable(s.sessionId)
    : await custodyBalanceOf(user.id)
  const canPay =
    can(user, PERMISSIONS.SETTLEMENTS_OPERATE) && s.status === "PENDING_PAYOUT"
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-8">
      <BackLink
        href={`${SETTLEMENTS_BASE}/${id}`}
        label={`Liquidación ${s.folio}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Pagos · {s.player.name}</h1>
        <SettlementStatusBadge status={s.status} />
      </div>
      {s.payable ? (
        <Card>
          <CardContent className="pt-4">
            <dl className="divide-y">
              <AmountRow
                label="Importe neto"
                value={formatMXN(s.payable.netPayout)}
                testId="payouts-net"
                strong
              />
              <AmountRow
                label="Pagado (efectivo + transferencias ejecutadas)"
                value={formatMXN(s.payable.paid)}
                testId="payouts-paid"
              />
              <AmountRow
                label="Transferencia en trámite (no pagada)"
                value={formatMXN(s.payable.inTransit)}
                testId="payouts-in-transit"
              />
              <AmountRow
                label="Saldo por pagar"
                value={formatMXN(s.payable.pending)}
                testId="payouts-pending"
                strong
              />
            </dl>
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-lg border p-3 text-sm" role="alert">
          Aún no hay nada que pagar: primero el jugador firma y el cajero
          confirma la recepción de las fichas.
        </p>
      )}
      {canPay && s.payable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">9 · Registrar pago</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p
              className="text-muted-foreground text-xs"
              data-testid="cash-source"
            >
              {sessionCash
                ? `Efectivo en la caja de la sesión ${s.session.folio}: ${formatMXN(cashAvailable)}.`
                : `La sesión ${s.session.folio} está cerrada: el efectivo sale de tu custodia administrativa (${formatMXN(cashAvailable)}). Para aportar fondos reales, ve a Pagos pendientes.`}
            </p>
            <RegisterPayoutForm
              settlementId={id}
              available={s.payable.available}
              cashSource={sessionCash ? "SESSION_CASH" : "ADMIN_CUSTODY"}
            />
          </CardContent>
        </Card>
      ) : null}
      <h2 className="text-base font-semibold">Historial de pagos</h2>
      {s.payouts.length === 0 ? (
        <p className="text-muted-foreground text-sm">Sin pagos registrados.</p>
      ) : (
        <ul className="space-y-2" data-testid="payout-list">
          {s.payouts.map((p) => (
            <li key={p.id}>
              <Card data-testid="payout-row">
                <CardContent className="space-y-2 pt-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      Pago {p.sequence} · {formatMXN(p.amount)}
                    </p>
                    <span className="text-xs" data-testid="payout-status">
                      {PAYOUT_STATUS_LABEL[p.status]}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {PAYOUT_FUNDING_LABEL[p.funding]}
                    {p.custodian ? ` (${p.custodian.name})` : ""}
                    {p.bankReference ? ` · ref. ${p.bankReference}` : ""}
                    {p.financialTransaction
                      ? ` · mov. ${p.financialTransaction.folio}`
                      : ""}
                    {" · "}
                    {formatDateTime(p.executedAt ?? p.createdAt)}
                    {p.failureReason ? ` · ${p.failureReason}` : ""}
                  </p>
                  {p.status === "PENDING" ? (
                    <ResolveTransferActions
                      settlementId={id}
                      payoutId={p.id}
                      canResolve={can(user, PERMISSIONS.CASH_OPERATE)}
                    />
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {s.receivedAt ? (
        <Link
          href={`${SETTLEMENTS_BASE}/${id}/comprobante`}
          className="text-muted-foreground block text-sm underline-offset-4 hover:underline"
          data-testid="payouts-go-receipt"
        >
          Ver comprobante y anexos
        </Link>
      ) : null}
    </div>
  )
}
