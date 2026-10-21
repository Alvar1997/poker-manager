import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { CorrectionRequestForm } from "@/modules/admin/components/admin-actions"
import { ADMIN_BASE, PageHeader } from "@/modules/admin/components/admin-ui"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Solicitar corrección — Poker Manager" }

export default async function NewCorrectionPage({
  searchParams,
}: PageProps<"/dashboard/administracion/correcciones/nueva">) {
  await requirePagePermission(
    PERMISSIONS.CORRECTIONS_REQUEST,
    `${ADMIN_BASE}/correcciones`
  )
  const sp = await searchParams
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <BackLink href={`${ADMIN_BASE}/correcciones`} label="Correcciones" />
      <PageHeader
        title="Solicitar corrección excepcional"
        description="Cualquier rol puede solicitar. Solo un socio o SUPERADMIN decide. Aprobar no mueve dinero ni fichas."
      />
      <Card>
        <CardContent>
          <CorrectionRequestForm
            initial={{ type: one(sp.type), targetId: one(sp.targetId) }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
