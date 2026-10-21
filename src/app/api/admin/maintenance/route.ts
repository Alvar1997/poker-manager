import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseJsonBody } from "@/lib/validation"
import { maintenanceSchema } from "@/modules/admin/admin.schemas"
import { setMaintenance } from "@/modules/backups/recovery.service"

export const dynamic = "force-dynamic"

/** POST — activa/desactiva el modo mantenimiento (SUPERADMIN + contraseña). */
export const POST = withApiHandler(async (req, { requestId }) => {
  const actor = await requirePermission(PERMISSIONS.RECOVERY_MANAGE, {
    requestId,
    resource: "POST /api/admin/maintenance",
  })
  const input = await parseJsonBody(req, maintenanceSchema)
  await setMaintenance(actor, input, { requestId })
  return ok(
    { enabled: input.enabled },
    {
      requestId,
      message: input.enabled
        ? "Mantenimiento activado"
        : "Mantenimiento desactivado",
    }
  )
})
