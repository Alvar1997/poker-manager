import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { getBackupConfig } from "@/modules/backups/backup.config"
import { backupAutomationStatus } from "@/modules/backups/backup.service"

export const dynamic = "force-dynamic"

export const GET = withApiHandler(async (_req, { requestId }) => {
  await requirePermission(PERMISSIONS.BACKUPS_READ, {
    requestId,
    resource: "GET /api/admin/backups/status",
  })
  const config = getBackupConfig()
  return ok(
    {
      ...(await backupAutomationStatus()),
      // Solo NOMBRES de variables faltantes; nunca valores.
      configuredInThisProcess: config.configured,
      missingInThisProcess: config.missing,
      restoreTestConfigured: Boolean(config.restoreTestUrl),
      retention: {
        dailyDays: config.retentionDailyDays,
        monthlyMonths: config.retentionMonthlyMonths,
      },
    },
    { requestId }
  )
})
