import { NextResponse } from "next/server"

import { withApiHandler } from "@/lib/api-handler"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { ValidationError } from "@/lib/errors"
import {
  idSchema,
  parsePurchaseIdParam,
} from "@/modules/purchases/purchase.schemas"
import { getSignatureEvidence } from "@/modules/signatures/signature.service"

export const dynamic = "force-dynamic"

/**
 * GET — imagen PRIVADA de la firma. Solo con sesión y permiso; nunca una
 * URL pública ni la clave interna de almacenamiento. Sin caché compartida.
 */
export const GET = withApiHandler<{ id: string }>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.SIGNATURES_READ, {
      requestId,
      resource: "GET /api/purchases/:id/signature-evidence",
    })
    const id = await parsePurchaseIdParam(params)
    const raw = req.nextUrl.searchParams.get("signatureId")
    if (raw !== null && !idSchema.safeParse(raw).success)
      throw new ValidationError("Identificador inválido")
    const evidence = await getSignatureEvidence(actor, id, raw, { requestId })
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
