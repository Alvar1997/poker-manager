import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { ReturnToOpenForm } from "@/modules/closure/components/closure-actions"
import { ClosureWizard } from "@/modules/closure/components/closure-wizard"
import { getClosureWizard } from "@/modules/closure/closure-wizard.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import { listStaff } from "@/modules/staff-tips/staff.service"

import { BackLink } from "../../back-link"
import { loadSession } from "../../load-session"

export const metadata = { title: "Cierre de jornada — Poker Manager" }

/**
 * Asistente de cierre en 6 pasos. Cada paso se valida en el servidor con
 * los datos reales; el paso visible viene de la URL (?paso=N) o del
 * progreso guardado. Las pantallas detalladas del cierre siguen existiendo
 * y se abren desde los botones RESOLVER.
 */
export default async function ClosureWizardPage({
  params,
  searchParams,
}: PageProps<"/dashboard/sesiones/[id]/cierre">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre`
  )
  const session = await loadSession(id, user)
  const [data, staff] = await Promise.all([
    getClosureWizard(id),
    listStaff({ active: true }),
  ])
  const raw = (await searchParams).paso
  const asked = Number(Array.isArray(raw) ? raw[0] : raw)
  const step =
    Number.isInteger(asked) && asked >= 1 && asked <= 6
      ? asked
      : Math.min(Math.max(data.currentStep, 1), 6)
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <BackLink
        href={`${SESSIONS_BASE}/${id}`}
        label={`Sesión ${session.folio}`}
      />
      <ClosureWizard
        data={data}
        step={step}
        staffOptions={staff.map((s) => ({
          id: s.id,
          name: s.name,
          position: s.position.name,
        }))}
        canOperate={can(user, PERMISSIONS.SESSIONS_MANAGE)}
        canConfirm={
          can(user, PERMISSIONS.SESSIONS_CLOSE_CONFIRM) &&
          // Una jornada histórica la cierra SUPERADMIN (elige la hora).
          (!data.session.isHistorical ||
            can(user, PERMISSIONS.SESSIONS_HISTORICAL_CREATE))
        }
      />
      {session.status === "CLOSING" &&
      can(user, PERMISSIONS.SESSIONS_MANAGE) ? (
        <details className="rounded-xl border p-3 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            Regresar la sesión a «Abierta» (excepcional)
          </summary>
          <p className="text-muted-foreground mb-2 text-xs">
            Solo si hay que registrar operaciones nuevas. Invalida este intento
            de cierre: tendrás que repetir los arqueos. Para solo recontar
            fichas, usa el paso 4.
          </p>
          <ReturnToOpenForm sessionId={id} />
        </details>
      ) : null}
    </div>
  )
}
