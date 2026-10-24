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
import { formatMXN } from "@/modules/cash/components/format"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Resumen del cierre — Poker Manager" }

function noActivityKind(p: Awaited<ReturnType<typeof buildClosurePreview>>) {
  return (p.closure?.kind ?? p.precheck.kind) === "NO_ACTIVITY"
}

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
  const canAuthorize = can(user, PERMISSIONS.SESSIONS_CLOSE_CONFIRM)
  // Módulo 18: diferencia nominal (entregado − jugadores − rake − propinas −
  // otros) y diferencia física del arqueo, por separado.
  const rec = p.inventory.reconciliation
  const nominal = rec.difference
  const nominalZero = !/[1-9]/.test(nominal)
  const nominalText = nominalZero
    ? null
    : nominal.startsWith("-")
      ? `Diferencia nominal: sobran ${formatMXN(nominal.slice(1))} respecto al valor nominal entregado`
      : `Diferencia nominal: faltan ${formatMXN(nominal)} por justificar`
  const physical =
    p.inventory.count?.reconciliationStatus === "PENDING"
      ? p.inventory.position.physicalDifference
      : null
  const physicalText =
    physical && /[1-9]/.test(physical)
      ? `Diferencia física del arqueo: ${physical.startsWith("-") ? `faltan ${formatMXN(physical.slice(1))}` : `sobran ${formatMXN(physical)}`} frente a lo esperado`
      : null
  const differenceText =
    noActivityKind(p) || (!nominalText && !physicalText)
      ? null
      : [nominalText, physicalText].filter(Boolean).join(" · ")
  const noActivity = noActivityKind(p)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Resumen y confirmación"
        current="resumen"
        description="Indicadores basados en operaciones reales. La diferencia entre compras y fichas devueltas de un jugador es su resultado individual, NO utilidad ni faltante: se compensa con los demás jugadores y el balance global de fichas se concilia."
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
      <Card data-testid="chip-reconciliation-summary">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Conciliación de fichas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <MoneyRow
              label="Fichas entregadas"
              value={rec.delivered}
              testId="rec-delivered"
            />
            <MoneyRow
              label="Devueltas por jugadores"
              value={rec.returnedByPlayers}
              testId="rec-players"
            />
            <MoneyRow
              label="Rake (todas las mesas)"
              value={rec.rake}
              testId="rec-rake"
            />
            <MoneyRow
              label="Propinas (todo el staff)"
              value={rec.tips}
              testId="rec-tips"
            />
            {/[1-9]/.test(rec.otherReturns) ? (
              <MoneyRow
                label="Otros retornos registrados"
                value={rec.otherReturns}
              />
            ) : null}
            {/[1-9]/.test(rec.authorizedUnrecovered) ? (
              <MoneyRow
                label="Diferencias autorizadas"
                value={rec.authorizedUnrecovered}
              />
            ) : null}
            <MoneyRow
              label="Diferencia nominal"
              value={rec.difference}
              strong
              testId="rec-nominal-difference"
              hint={
                nominalZero
                  ? "Cuadra"
                  : nominal.startsWith("-")
                    ? "Sobran fichas frente a lo entregado"
                    : "Faltan fichas por justificar"
              }
            />
            <MoneyRow
              label="Arqueo: esperado"
              value={p.inventory.position.expectedCustody}
            />
            <MoneyRow
              label="Arqueo: contado"
              value={p.inventory.position.countedCustody}
            />
            <MoneyRow
              label="Diferencia física (arqueo)"
              value={p.inventory.position.physicalDifference}
              strong
              testId="rec-physical-difference"
            />
          </dl>
          <p className="text-muted-foreground mt-2 text-xs">
            Son dos comparaciones distintas: la nominal explica el destino de
            las fichas entregadas; la física compara el inventario contado
            contra el esperado.
          </p>
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
                difference={differenceText}
              />
            ) : (
              <p
                className="flex items-start gap-2 text-sm"
                data-testid="closure-confirm-restricted"
              >
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                No tienes permiso para confirmar el cierre definitivo.
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
