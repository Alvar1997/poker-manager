import type { ReactNode } from "react"

import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { AdminNav, type AdminTab } from "@/modules/admin/components/admin-nav"
import { ADMIN_BASE } from "@/modules/admin/components/admin-ui"

/**
 * Administración (Módulo 15). Los tres roles consultan la auditoría
 * (DEC-01..03); las pestañas de infraestructura y seguridad se muestran
 * solo con su permiso (cada página vuelve a autorizar en el servidor).
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requirePagePermission(PERMISSIONS.AUDIT_READ, ADMIN_BASE)
  const tabs: AdminTab[] = [
    { slug: "", label: "Panel" },
    { slug: "auditoria", label: "Auditoría" },
    { slug: "correcciones", label: "Correcciones" },
    { slug: "integridad", label: "Integridad" },
    { slug: "incidencias", label: "Incidencias" },
    ...(can(user, PERMISSIONS.STAFF_READ)
      ? [{ slug: "staff", label: "Staff" }]
      : []),
    ...(can(user, PERMISSIONS.BANKING_READ)
      ? [{ slug: "bancaje", label: "Bancaje" }]
      : []),
    ...(can(user, PERMISSIONS.AUDIT_SECURITY_READ)
      ? [{ slug: "seguridad", label: "Seguridad" }]
      : []),
    ...(can(user, PERMISSIONS.BACKUPS_READ)
      ? [{ slug: "respaldos", label: "Respaldos" }]
      : []),
    ...(can(user, PERMISSIONS.RECOVERY_MANAGE)
      ? [{ slug: "recuperacion", label: "Recuperación" }]
      : []),
    ...(can(user, PERMISSIONS.SYSTEM_HEALTH_READ)
      ? [{ slug: "sistema", label: "Estado del sistema" }]
      : []),
  ]
  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <AdminNav tabs={tabs} />
      {children}
    </div>
  )
}
