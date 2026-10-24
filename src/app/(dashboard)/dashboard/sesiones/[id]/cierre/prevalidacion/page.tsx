import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { FindingList } from "@/modules/closure/components/closure-ui"
import { computePrecheck } from "@/modules/closure/closure.data"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Prevalidación del cierre — Poker Manager" }

export default async function ClosurePrecheckPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/prevalidacion">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/prevalidacion`
  )
  const session = await loadSession(id, user)
  const p = await computePrecheck(prisma, id)
  const group = (s: "BLOCKING" | "WARNING" | "INFO") =>
    p.findings.filter((f) => f.severity === s)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Prevalidación"
        current="prevalidacion"
        description="Solo los BLOQUEOS impiden cerrar. Las advertencias (deudas, pagos pendientes, transferencias) son dinero y se conservan después del cierre. Las fichas se concilian GLOBALMENTE: nadie se lleva fichas."
      />
      <p className="text-sm" data-testid="precheck-summary">
        {p.summary.blocking} bloqueo(s) · {p.summary.warnings} advertencia(s) ·{" "}
        {p.summary.info} dato(s)
      </p>
      {(["BLOCKING", "WARNING", "INFO"] as const).map((s) => (
        <Card key={s}>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              {s === "BLOCKING"
                ? "Bloqueos"
                : s === "WARNING"
                  ? "Advertencias (no bloquean)"
                  : "Información"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FindingList findings={group(s)} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
