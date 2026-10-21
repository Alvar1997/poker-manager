import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { z } from "zod"

import { listBackups } from "@/modules/backups/backup.service"

export const dynamic = "force-dynamic"

const query = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
})

/** GET — historial REAL de respaldos (sin rutas absolutas ni secretos). */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.BACKUPS_READ, {
    requestId,
    resource: "GET /api/admin/backups",
  })
  const q = parseQueryParams(req.nextUrl.searchParams, query)
  return ok(await listBackups(q.page, q.pageSize), { requestId })
})
