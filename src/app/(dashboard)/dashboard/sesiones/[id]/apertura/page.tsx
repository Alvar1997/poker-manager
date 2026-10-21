import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { getOpeningChecklist } from "@/modules/sessions/opening.service"
import { OpeningChecklistView } from "@/modules/sessions/components/opening-checklist"
import { OpenSessionButton } from "@/modules/sessions/components/session-actions"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"

export const metadata = { title: "Apertura de sesión — Poker Manager" }

export default async function OpeningPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/apertura">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/apertura`
  )
  const session = await loadSession(id, user)
  const checklist = await getOpeningChecklist(id, user)
  const step = (sid: string) => checklist.steps.find((s) => s.id === sid)!

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/preparacion`}
        label="Preparación"
      />
      <h1 className="text-xl font-semibold">
        Confirmar apertura · {session.folio}
      </h1>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Resumen
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">Responsable</dt>
              <dd>{session.createdBy.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Arqueo de fichas
              </dt>
              <dd>
                {step("CHIP_COUNT_CONFIRMED").status === "DONE"
                  ? "Confirmado"
                  : "Pendiente"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Diferencias</dt>
              <dd>
                {step("DIFFERENCES_RECONCILED").status === "DONE"
                  ? "Conciliadas"
                  : "Pendientes"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Caja física inicial
              </dt>
              <dd>
                {step("CASH_ZERO_CONFIRMED").status === "DONE"
                  ? "$0.00 confirmados"
                  : "Sin confirmar"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Mesas abiertas inicialmente
              </dt>
              <dd data-testid="initial-open-tables">
                {checklist.initialOpenTables}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Fecha y hora</dt>
              <dd>Se registrarán automáticamente al confirmar</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <OpeningChecklistView checklist={checklist} />
        </CardContent>
      </Card>
      {checklist.ready ? null : (
        <p className="text-destructive text-sm" data-testid="opening-blockers">
          {checklist.blockers[0]}
        </p>
      )}
      <OpenSessionButton sessionId={id} disabled={!checklist.ready} />
    </div>
  )
}
