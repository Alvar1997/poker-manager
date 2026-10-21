import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  AuthorizeAdjustmentForm,
  DiscrepancyNoteForm,
} from "@/modules/closure/components/closure-actions"
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
  const list = await listDiscrepancies(prisma, id)
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
        description="Solo diferencias FÍSICAS (contado ≠ esperado). Las fichas no retornadas NO son diferencia: quedan en circulación. Una diferencia bloquea el cierre hasta resolverla: recuento, regreso a Abierta o ajuste excepcional autorizado por un socio o superadministrador."
      />
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
