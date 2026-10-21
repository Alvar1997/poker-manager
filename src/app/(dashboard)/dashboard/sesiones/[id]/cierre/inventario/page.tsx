import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { StartClosingCountButton } from "@/modules/closure/components/closure-actions"
import { ChipFigures, MoneyRow } from "@/modules/closure/components/closure-ui"
import { getInventoryStatus } from "@/modules/closure/closure.data"
import { CountStatusBadges } from "@/modules/inventory/components/count-status"
import { CountWorkspace } from "@/modules/inventory/components/count-workspace"
import { getStockCount } from "@/modules/inventory/stock-count.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Arqueo final de fichas — Poker Manager" }

export default async function ClosureInventoryPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/inventario">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/inventario`
  )
  const session = await loadSession(id, user)
  const inv = await getInventoryStatus(prisma, id)
  const count = inv.count ? await getStockCount(inv.count.id) : null
  const canOperate =
    session.status === "CLOSING" && can(user, PERMISSIONS.SESSIONS_MANAGE)
  const needsCount =
    !count ||
    (count.status === "CONFIRMED" &&
      (count.reconciliationStatus === "PENDING" || !count.current))
  const n = inv.nominal

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Arqueo final de fichas"
        current="inventario"
        description="Un solo arqueo físico GLOBAL del inventario compartido, después de cerrar todas las mesas. Se cuenta por denominación; las compras y liquidaciones siguen siendo solo por importe."
      />

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Valor nominal esperado bajo custodia
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y" data-testid="nominal-calculation">
            <MoneyRow
              label="Custodia conciliada al abrir"
              value={n.openingCustody}
            />
            <MoneyRow
              label="Entregas a jugadores (compras)"
              value={n.deliveries}
            />
            <MoneyRow
              label="Devoluciones recibidas (liquidaciones)"
              value={n.returns}
            />
            <MoneyRow label="Ajustes legítimos" value={n.adjustments} />
            <MoneyRow label="Altas de inventario" value={n.entries} />
            <MoneyRow label="Bajas definitivas" value={n.withdrawals} />
            <MoneyRow
              label="Esperado bajo custodia"
              value={n.projectedCustody}
              strong
              testId="nominal-expected"
            />
          </dl>
          {!n.consistent ? (
            <p className="text-destructive mt-2 text-sm" role="alert">
              El cálculo desde la apertura no coincide con el libro: revisa el
              inventario.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <ChipFigures {...inv.position} />

      {session.status === "CLOSING" ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Conteo físico por denominación
            </CardTitle>
            {count ? (
              <CountStatusBadges
                status={count.status}
                reconciliationStatus={count.reconciliationStatus}
              />
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {needsCount && canOperate ? (
              <StartClosingCountButton
                sessionId={id}
                label={
                  !count
                    ? "Iniciar arqueo final"
                    : count.reconciliationStatus === "PENDING"
                      ? "Recontar (recuento físico)"
                      : "Volver a contar"
                }
              />
            ) : null}
            {count && count.status === "CONFIRMED" && count.current ? (
              <p
                className="text-sm text-emerald-700 dark:text-emerald-400"
                data-testid="closure-count-current"
              >
                Arqueo vigente: no hubo movimientos de fichas después.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {count &&
      (count.status === "DRAFT" ||
        !needsCount ||
        count.reconciliationStatus === "PENDING") ? (
        <CountWorkspace
          key={`${count.id}-${count.status}-${count.reconciliationStatus}`}
          count={count}
          canOperate={canOperate}
          closureSessionId={id}
        />
      ) : null}
    </div>
  )
}
