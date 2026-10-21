import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { IncidentCreateForm } from "@/modules/admin/components/admin-actions"
import { ADMIN_BASE, PageHeader } from "@/modules/admin/components/admin-ui"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Registrar incidencia — Poker Manager" }

export default async function NewIncidentPage() {
  await requirePagePermission(
    PERMISSIONS.INCIDENTS_MANAGE,
    `${ADMIN_BASE}/incidencias`
  )
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <BackLink href={`${ADMIN_BASE}/incidencias`} label="Incidencias" />
      <PageHeader
        title="Registrar incidencia"
        description="Registra el hallazgo; una incidencia no corrige datos."
      />
      <Card>
        <CardContent>
          <IncidentCreateForm />
        </CardContent>
      </Card>
    </div>
  )
}
