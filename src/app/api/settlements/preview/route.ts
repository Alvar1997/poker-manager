import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { parseQueryParams } from "@/lib/validation"
import { draftPreviewQuerySchema } from "@/modules/settlements/settlement.schemas"
import { previewDraft } from "@/modules/settlements/settlement.service"

export const dynamic = "force-dynamic"

/** GET — vista previa INFORMATIVA (compensación FIFO y neto); no guarda nada. */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.SETTLEMENTS_READ, {
    requestId,
    resource: "GET /api/settlements/preview",
  })
  return ok(
    await previewDraft(
      parseQueryParams(req.nextUrl.searchParams, draftPreviewQuerySchema)
    ),
    { requestId }
  )
})
