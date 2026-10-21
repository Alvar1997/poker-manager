import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  parseOptionalId,
  parseSettlementIdParam,
} from "@/modules/settlements/settlement.schemas"
import { getSettlementSignatureEvidence } from "@/modules/settlements/settlement-signature.service"

export const dynamic = "force-dynamic"

/** GET — imagen PRIVADA de la firma (sin URL pública ni caché compartida). */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SIGNATURES_READ, {
      requestId,
      resource: "GET /api/settlements/:id/signature-evidence",
    })
    const id = await parseSettlementIdParam(params)
    const signatureId = parseOptionalId(
      req.nextUrl.searchParams.get("signatureId")
    )
    const evidence = await getSettlementSignatureEvidence(
      actor,
      id,
      signatureId,
      {
        requestId,
      }
    )
    return new NextResponse(new Uint8Array(evidence.bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "x-request-id": requestId,
      },
    })
  }
)
