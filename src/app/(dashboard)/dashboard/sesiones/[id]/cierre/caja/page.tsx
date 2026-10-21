import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { CashCountForm } from "@/modules/closure/components/closure-actions"
import { MoneyRow } from "@/modules/closure/components/closure-ui"
import { getCashStatus } from "@/modules/closure/closure.data"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = {
  title: "Arqueo de efectivo de cierre — Poker Manager",
}

const DIFF_LABEL: Record<string, string> = {
  NOT_REQUIRED: "Sin diferencia",
  PENDING: "Diferencia pendiente",
  ADJUSTED: "Ajustada con autorización",
  SUPERSEDED: "Sustituida por recuento",
}

export default async function ClosureCashPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/caja">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/caja`
  )
  const session = await loadSession(id, user)
  const cash = await getCashStatus(prisma, id)
  const canOperate =
    session.status === "CLOSING" &&
    can(user, PERMISSIONS.SESSIONS_MANAGE) &&
    !cash.withdrawal

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Arqueo de efectivo"
        current="caja"
        description="La caja abrió en $0.00. Esperado = entradas confirmadas de efectivo − salidas confirmadas. No incluye transferencias pendientes, terminal, deudas, compensaciones ni fichas."
      />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Efectivo esperado (libro)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y" data-testid="cash-breakdown">
            <MoneyRow label="Apertura" value={cash.openingAmount} />
            {cash.byType.map((t) => (
              <div key={t.type} className="py-1">
                <MoneyRow label={`${t.label} (entradas)`} value={t.inflow} />
                <MoneyRow label={`${t.label} (salidas)`} value={t.outflow} />
              </div>
            ))}
            <MoneyRow
              label="Esperado en caja"
              value={cash.expected}
              strong
              testId="cash-expected"
            />
          </dl>
        </CardContent>
      </Card>
      {cash.count ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Último arqueo de cierre
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <MoneyRow label="Esperado" value={cash.count.expectedAmount} />
              <MoneyRow
                label="Contado"
                value={cash.count.countedAmount}
                testId="cash-counted"
              />
              <MoneyRow
                label="Diferencia"
                value={cash.count.differenceAmount}
                strong
                testId="cash-difference"
              />
            </dl>
            <p className="mt-2 text-sm" data-testid="cash-difference-status">
              {DIFF_LABEL[cash.count.differenceStatus] ??
                cash.count.differenceStatus}
              {cash.count.explanation ? ` · ${cash.count.explanation}` : ""}
            </p>
          </CardContent>
        </Card>
      ) : null}
      {canOperate ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              {cash.count ? "Recontar el efectivo" : "Contar el efectivo"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CashCountForm sessionId={id} expected={cash.expected} />
          </CardContent>
        </Card>
      ) : null}
      {cash.withdrawal ? (
        <p className="text-sm" data-testid="cash-withdrawn-note">
          El retiro final ya se registró: la caja quedó en $0.00.
        </p>
      ) : null}
    </div>
  )
}
