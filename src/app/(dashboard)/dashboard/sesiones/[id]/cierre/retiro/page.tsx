import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import { WithdrawalForm } from "@/modules/closure/components/closure-actions"
import { MoneyRow } from "@/modules/closure/components/closure-ui"
import { getCashStatus } from "@/modules/closure/closure.data"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Retiro final de efectivo — Poker Manager" }

export default async function ClosureWithdrawalPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/retiro">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/retiro`
  )
  const session = await loadSession(id, user)
  const cash = await getCashStatus(prisma, id)
  const countOk =
    cash.count &&
    (cash.count.differenceStatus === "NOT_REQUIRED" ||
      cash.count.differenceStatus === "ADJUSTED")
  const canOperate =
    session.status === "CLOSING" &&
    can(user, PERMISSIONS.SESSIONS_MANAGE) &&
    !cash.withdrawal &&
    countOk &&
    cash.hasCash

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Retiro final"
        current="retiro"
        description="Salida física real de TODO el efectivo para dejar la caja en $0.00. No es gasto. Se registra importe, operador, receptor y hora."
      />
      <Card>
        <CardContent>
          <dl className="divide-y">
            <MoneyRow
              label="Efectivo disponible en caja"
              value={cash.expected}
              strong
              testId="withdrawal-cash"
            />
          </dl>
        </CardContent>
      </Card>
      {cash.withdrawal ? (
        <Card data-testid="withdrawal-done">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Retiro registrado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <MoneyRow label="Importe" value={cash.withdrawal.amount} />
            <p>
              Recibió:{" "}
              <span data-testid="withdrawal-recipient">
                {cash.withdrawal.recipientName}
              </span>
            </p>
            <p>Entregó: {cash.withdrawal.withdrawnBy.name}</p>
            <p>Fecha: {formatDateTime(cash.withdrawal.withdrawalAt)}</p>
            <p>
              Movimiento:{" "}
              <span className="font-mono">
                {cash.withdrawal.transaction.folio}
              </span>
            </p>
            {cash.withdrawal.notes ? (
              <p>Notas: {cash.withdrawal.notes}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {!cash.withdrawal && session.status === "CLOSING" && !countOk ? (
        <p className="text-sm" data-testid="withdrawal-needs-count">
          Primero registra el arqueo de efectivo de cierre y resuelve su
          diferencia, si la hay.
        </p>
      ) : null}
      {!cash.withdrawal && countOk && !cash.hasCash ? (
        <p className="text-sm" data-testid="withdrawal-not-needed">
          La caja está en $0.00: no hay efectivo que retirar.
        </p>
      ) : null}
      {canOperate ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Registrar retiro final
            </CardTitle>
          </CardHeader>
          <CardContent>
            <WithdrawalForm sessionId={id} available={cash.toWithdraw} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
