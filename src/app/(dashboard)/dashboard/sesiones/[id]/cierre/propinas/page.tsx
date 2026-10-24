import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatMXN } from "@/modules/cash/components/format"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import {
  AddSessionStaffForm,
  StaffTipRow,
} from "@/modules/staff-tips/components/staff-actions"
import { listStaff } from "@/modules/staff-tips/staff.service"
import { getSessionTips } from "@/modules/staff-tips/tips.service"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Propinas de la sesión — Poker Manager" }

/**
 * Propinas por empleado (Módulo 18, simplificado): Empleado | Puesto |
 * Importe contado, y el total. Solo el conteo CONFIRMADO de cada empleado
 * cuenta (una vez) en la conciliación de fichas. No hay pagos ni firmas
 * del staff.
 */
export default async function SessionTipsPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/propinas">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.STAFF_READ,
    `${SESSIONS_BASE}/${id}/cierre/propinas`
  )
  const session = await loadSession(id, user)
  const [t, staff] = await Promise.all([
    getSessionTips(id),
    listStaff({ active: true }),
  ])
  const editable =
    (session.status === "OPEN" || session.status === "CLOSING") &&
    can(user, PERMISSIONS.TIPS_OPERATE)
  const assigned = new Set(t.staff.map((s) => s.staff.id))
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Propinas del staff"
        current="propinas"
        description="Las propinas son de cada empleado y no se descuentan del rake. Captura lo que cuentas, guárdalo como borrador y confírmalo: solo el conteo confirmado entra en la conciliación de fichas, una vez."
      />
      {editable ? (
        <Card>
          <CardContent className="pt-4">
            <AddSessionStaffForm
              sessionId={id}
              staff={staff
                .filter((s) => !assigned.has(s.id))
                .map((s) => ({
                  id: s.id,
                  name: s.name,
                  position: s.position.name,
                }))}
            />
          </CardContent>
        </Card>
      ) : null}
      {t.staff.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Aún no hay personal en esta sesión.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border" data-testid="staff-tips">
          {t.staff.map((row) => (
            <StaffTipRow
              key={row.id}
              sessionId={id}
              row={row}
              editable={editable}
            />
          ))}
        </ul>
      )}
      <div
        className="flex items-baseline justify-between rounded-xl border p-3"
        data-testid="tips-total-card"
      >
        <span className="font-semibold">TOTAL PROPINAS</span>
        <span
          className="text-lg font-semibold tabular-nums"
          data-testid="tips-total"
        >
          {formatMXN(t.total)}
        </span>
      </div>
      {t.unconfirmed > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
          {t.unconfirmed} empleado(s) sin conteo confirmado: no cuentan en la
          conciliación hasta confirmarlo.
        </p>
      ) : null}
    </div>
  )
}
