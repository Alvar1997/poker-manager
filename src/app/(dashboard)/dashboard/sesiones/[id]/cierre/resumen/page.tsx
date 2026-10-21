import { Lock } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { ConfirmClosureForm } from "@/modules/closure/components/closure-actions"
import {
  ChipFigures,
  FindingList,
  MoneyRow,
  ReadinessList,
} from "@/modules/closure/components/closure-ui"
import { buildClosurePreview } from "@/modules/closure/closure.data"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Resumen del cierre — Poker Manager" }

export default async function ClosureSummaryPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/resumen">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/resumen`
  )
  const session = await loadSession(id, user)
  const p = await buildClosurePreview(prisma, id)
  const f = p.financial
  const canAuthorize = can(user, PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
  const noActivity = (p.closure?.kind ?? p.precheck.kind) === "NO_ACTIVITY"

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Resumen y confirmación"
        current="resumen"
        description="Indicadores basados en operaciones reales. La diferencia entre compras y fichas devueltas NO es utilidad: las fichas no retornadas son valor pendiente de retorno."
      />
      {noActivity ? (
        <p
          className="rounded-lg border p-3 text-sm"
          data-testid="closure-no-activity"
        >
          Cierre SIN ACTIVIDAD: la sesión nunca abrió una mesa. El motivo es
          obligatorio.
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Requisitos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadinessList checks={p.readiness.checks} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Operación
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y text-sm">
            <div className="flex justify-between py-1">
              <dt className="text-muted-foreground">Mesas que operaron</dt>
              <dd>{f.tables.names.join(", ") || "Ninguna"}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted-foreground">Ciclos</dt>
              <dd>
                {f.tables.cyclesClosed} cerrados · {f.tables.cyclesOpen}{" "}
                abiertos
              </dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted-foreground">Jugadores distintos</dt>
              <dd data-testid="summary-players">{f.players}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted-foreground">
                Compras iniciales / recompras
              </dt>
              <dd>
                {f.purchases.initialCount} / {f.purchases.rebuyCount}
              </dd>
            </div>
            <MoneyRow label="Fichas entregadas" value={f.chips.delivered} />
            <MoneyRow label="Fichas devueltas" value={f.chips.returned} />
            <MoneyRow
              label="Cobrado en efectivo"
              value={f.purchases.paidCash}
            />
            <MoneyRow
              label="Cobrado por transferencia (verificado)"
              value={f.purchases.paidTransferConfirmed}
            />
            <MoneyRow
              label="Transferencias por verificar"
              value={f.purchases.paidTransferPending}
            />
            <MoneyRow
              label="Cobrado con terminal"
              value={f.purchases.paidCardApproved}
            />
            <MoneyRow
              label="Créditos originados"
              value={f.credits.originated}
            />
            <MoneyRow label="Abonos en efectivo" value={f.abonos.cash} />
            <MoneyRow
              label="Liquidaciones pagadas (efectivo)"
              value={f.settlements.paidCash}
            />
            <MoneyRow
              label="Liquidaciones pagadas (transferencia)"
              value={f.settlements.paidTransfer}
            />
            <MoneyRow
              label="Liquidaciones pendientes"
              value={f.settlements.pendingAmount}
            />
            <MoneyRow label="Efectivo retirado" value={f.cash.withdrawn} />
            <MoneyRow
              label="Caja final"
              value={f.cash.final}
              strong
              testId="summary-final-cash"
            />
          </dl>
        </CardContent>
      </Card>
      <ChipFigures {...p.inventory.position} />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Pendientes que sobreviven al cierre
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FindingList
            findings={p.precheck.findings.filter(
              (x) => x.severity === "WARNING"
            )}
          />
        </CardContent>
      </Card>
      {session.status === "CLOSING" ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Confirmación definitiva
            </CardTitle>
          </CardHeader>
          <CardContent>
            {canAuthorize ? (
              <ConfirmClosureForm
                sessionId={id}
                previewHash={p.previewHash}
                noActivity={noActivity}
                // El motivo del cierre sin actividad se captura en este mismo
                // formulario; el servidor vuelve a exigirlo al confirmar.
                ready={p.readiness.checks.every(
                  (c) => c.ok || c.id === "NO_ACTIVITY_REASON"
                )}
              />
            ) : (
              <p
                className="flex items-start gap-2 text-sm"
                data-testid="closure-confirm-restricted"
              >
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Solo un socio o un superadministrador puede confirmar el cierre
                definitivo. Puedes preparar todo y avisarle.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
      <p className="text-muted-foreground text-xs break-all">
        Huella del resumen: {p.previewHash}
      </p>
    </div>
  )
}
