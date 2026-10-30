import { redirect } from "next/navigation"

import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { getCustodySummary } from "@/modules/credits/custody.service"
import { OpeningWizard } from "@/modules/sessions/components/opening-wizard"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import { getOpeningWizard } from "@/modules/sessions/opening-wizard.service"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"

export const metadata = { title: "Apertura de jornada — Poker Manager" }

/**
 * Asistente de apertura en 4 pasos. Cada paso se valida en el servidor con
 * los registros reales; el paso visible viene de la URL (?paso=N), del
 * progreso guardado o, si no hay, del primer paso pendiente. Una jornada ya
 * abierta se consulta desde su panel.
 */
export default async function OpeningWizardPage({
  params,
  searchParams,
}: PageProps<"/dashboard/sesiones/[id]/apertura">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/apertura`
  )
  const session = await loadSession(id, user)
  if (
    session.status !== "DRAFT" &&
    session.status !== "PREPARATION" &&
    session.status !== "CANCELLED"
  )
    redirect(`${SESSIONS_BASE}/${id}`)
  const [data, custody] = await Promise.all([
    getOpeningWizard(id, user),
    getCustodySummary(),
  ])
  const raw = (await searchParams).paso
  const asked = Number(Array.isArray(raw) ? raw[0] : raw)
  const step =
    Number.isInteger(asked) && asked >= 1 && asked <= 4
      ? asked
      : Math.min(Math.max(data.currentStep ?? data.suggestedStep, 1), 4)
  const canOperate =
    can(user, PERMISSIONS.SESSIONS_MANAGE) &&
    session.canManagePreparation &&
    (session.status === "DRAFT" || session.status === "PREPARATION")
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <BackLink
        href={`${SESSIONS_BASE}/${id}`}
        label={`Sesión ${session.folio}`}
      />
      <OpeningWizard
        data={data}
        step={step}
        canOperate={canOperate}
        canHistorical={can(user, PERMISSIONS.SESSIONS_HISTORICAL_CREATE)}
        custodyTotal={custody.total}
      />
    </div>
  )
}
