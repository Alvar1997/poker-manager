import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { CountStatusBadges } from "@/modules/inventory/components/count-status"
import { CountWorkspace } from "@/modules/inventory/components/count-workspace"
import { StartOpeningCountButton } from "@/modules/sessions/components/session-actions"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import { getOpeningInventoryStatus } from "@/modules/sessions/opening.service"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"

export const metadata = { title: "Arqueo de apertura — Poker Manager" }

export default async function OpeningCountPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/arqueo-fichas">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/arqueo-fichas`
  )
  const session = await loadSession(id, user)
  const count = await getOpeningInventoryStatus(id)
  const canOperate =
    session.canManagePreparation && session.status === "PREPARATION"
  const needsNew =
    !count ||
    (count.status === "CONFIRMED" &&
      count.reconciliationStatus !== "PENDING" &&
      !count.current)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/preparacion`}
        label="Preparación"
      />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">
          Arqueo de apertura · {session.folio}
        </h1>
        <p className="text-muted-foreground text-sm">
          Inventario compartido por ambas mesas: un solo conteo de todas las
          denominaciones.
        </p>
        {count ? (
          <CountStatusBadges
            status={count.status}
            reconciliationStatus={count.reconciliationStatus}
          />
        ) : null}
      </div>

      {needsNew ? (
        <Card>
          <CardContent className="space-y-3 text-sm">
            <p>
              {count
                ? "El arqueo anterior quedó obsoleto (hubo movimientos de fichas): vuelve a contar."
                : "Aún no se ha contado el inventario para esta sesión."}
            </p>
            {canOperate ? (
              <StartOpeningCountButton sessionId={id} label="Iniciar arqueo" />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {count && !needsNew ? (
        <CountWorkspace count={count} canOperate={canOperate} />
      ) : null}
    </div>
  )
}
