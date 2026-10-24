import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  AuthorizeAdjustmentForm,
  DiscrepancyNoteForm,
  SessionChipReconciliationForm,
} from "@/modules/closure/components/closure-actions"
import { getInventoryStatus } from "@/modules/closure/closure.data"
import { MoneyRow } from "@/modules/closure/components/closure-ui"
import { listDiscrepancies } from "@/modules/closure/closure.data"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Diferencias del cierre — Poker Manager" }

const RESOLUTION_LABEL: Record<string, string> = {
  RECOUNT: "Recuento físico",
  RETURNED_TO_OPEN: "Regreso a Abierta",
  AUTHORIZED_ADJUSTMENT: "Ajuste excepcional autorizado",
}

export default async function ClosureDiscrepanciesPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/diferencias">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/diferencias`
  )
  const session = await loadSession(id, user)
  const [list, inventory] = await Promise.all([
    listDiscrepancies(prisma, id),
    getInventoryStatus(prisma, id),
  ])
  const rec = inventory.reconciliation
  const surplus =
    inventory.position.physicalDifference &&
    Number(inventory.position.physicalDifference) > 0
      ? inventory.position.physicalDifference
      : "0.00"
  const identifiable = (
    Math.min(Number(surplus), Number(rec.difference)) || 0
  ).toFixed(2)
  const closing = session.status === "CLOSING"
  const canManage = closing && can(user, PERMISSIONS.SESSIONS_MANAGE)
  const canAuthorize =
    closing && can(user, PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Diferencias de arqueo"
        current="diferencias"
        description="Diferencias FÍSICAS (contado ≠ esperado) y la diferencia NOMINAL global de la sesión (entregado − devuelto con todos los jugadores terminados). Ningún jugador se lleva fichas; los resultados individuales no son diferencia. Cada una bloquea el cierre hasta conciliarla con un hecho autorizado."
      />
      <Card data-testid="nominal-reconciliation" data-status={rec.status}>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Conciliación global de fichas ·{" "}
            {rec.status === "RECONCILED"
              ? "Conciliada"
              : rec.status === "IN_PLAY"
                ? "En juego"
                : rec.status === "UNEXPLAINED_DIFFERENCE"
                  ? "Diferencia por conciliar"
                  : "Devuelto de circulación anterior"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="divide-y">
            <MoneyRow label="Entregado (ambas mesas)" value={rec.delivered} />
            <MoneyRow label="Devuelto (ambas mesas)" value={rec.returned} />
            <MoneyRow
              label="Diferencias autorizadas"
              value={rec.authorizedUnrecovered}
            />
            <MoneyRow
              label="Diferencia por conciliar"
              value={
                rec.status === "UNEXPLAINED_DIFFERENCE"
                  ? rec.difference
                  : "0.00"
              }
              strong
              testId="nominal-difference"
            />
          </dl>
          {rec.status === "UNEXPLAINED_DIFFERENCE" && canAuthorize ? (
            <SessionChipReconciliationForm
              sessionId={id}
              difference={rec.difference}
              identifiable={
                inventory.count?.status === "CONFIRMED" ? identifiable : "0.00"
              }
            />
          ) : null}
          {rec.status === "UNEXPLAINED_DIFFERENCE" && !canAuthorize ? (
            <p className="text-xs" data-testid="nominal-needs-partner">
              Requiere la conciliación de un socio o superadministrador.
            </p>
          ) : null}
        </CardContent>
      </Card>
      {list.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="no-discrepancies"
        >
          No hay diferencias físicas registradas.
        </p>
      ) : null}
      {list.map((d) => (
        <Card key={d.id} data-testid="discrepancy" data-status={d.status}>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              {d.kind === "CASH" ? "Efectivo" : "Fichas"} ·{" "}
              {d.status === "OPEN" ? "Sin resolver" : "Resuelta"}
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              Detectada {formatDateTime(d.detectedAt)}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="divide-y">
              <MoneyRow label="Esperado" value={d.expectedAmount} />
              <MoneyRow label="Contado" value={d.countedAmount} />
              <MoneyRow
                label="Diferencia"
                value={d.differenceAmount}
                strong
                testId="discrepancy-difference"
              />
            </dl>
            {d.investigationNotes ? (
              <pre className="text-muted-foreground text-xs whitespace-pre-wrap">
                {d.investigationNotes}
              </pre>
            ) : null}
            {d.status === "RESOLVED" ? (
              <p className="text-sm" data-testid="discrepancy-resolution">
                {RESOLUTION_LABEL[d.resolution ?? ""] ?? d.resolution} ·{" "}
                {d.resolvedBy?.name}
                {d.resolvedAt ? ` · ${formatDateTime(d.resolvedAt)}` : ""}
                {d.adjustment ? ` · motivo: ${d.adjustment.reason}` : ""}
              </p>
            ) : null}
            {d.status === "OPEN" && canManage ? (
              <DiscrepancyNoteForm sessionId={id} discrepancyId={d.id} />
            ) : null}
            {d.status === "OPEN" && canAuthorize ? (
              <AuthorizeAdjustmentForm
                sessionId={id}
                discrepancyId={d.id}
                difference={d.differenceAmount}
              />
            ) : null}
            {d.status === "OPEN" && canManage && !canAuthorize ? (
              <p
                className="text-muted-foreground text-xs"
                data-testid="adjustment-requires-partner"
              >
                Para resolverla: vuelve a contar, regresa la sesión a Abierta o
                pide a un socio o superadministrador que autorice un ajuste
                excepcional.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
