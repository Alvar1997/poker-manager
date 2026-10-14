import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import {
  WHATSAPP_CONSENT_NOTICE,
  WHATSAPP_CONSENT_NOTICE_VERSION,
} from "@/modules/players/consent-notice"
import {
  consentActionSchema,
  parsePlayerIdParam,
} from "@/modules/players/player.schemas"
import {
  getConsentHistory,
  getConsentStatus,
  recordWhatsAppConsent,
} from "@/modules/players/player.service"

export const dynamic = "force-dynamic"

type Params = { id: string }

/** GET — estado vigente, historial y aviso vigente (para mostrarlo al jugador). */
export const GET = withApiHandler<Params>(
  async (_req, { params, requestId }) => {
    await requirePermission(PERMISSIONS.PLAYERS_READ, {
      requestId,
      resource: "GET /api/players/:id/notification-consent",
    })
    const id = await parsePlayerIdParam(params)
    const [status, history] = await Promise.all([
      getConsentStatus(id),
      getConsentHistory(id),
    ])
    return ok(
      {
        channel: "WHATSAPP",
        status,
        history,
        notice: {
          version: WHATSAPP_CONSENT_NOTICE_VERSION,
          text: WHATSAPP_CONSENT_NOTICE,
        },
      },
      { requestId }
    )
  }
)

/**
 * POST — registra una aceptación (exige confirmar que el jugador aceptó
 * expresamente el aviso vigente) o una revocación. No envía mensajes.
 */
export const POST = withApiHandler<Params>(
  async (req, { params, requestId }) => {
    const actor = await requirePermission(PERMISSIONS.PLAYERS_CONSENT, {
      requestId,
      resource: "POST /api/players/:id/notification-consent",
    })
    const id = await parsePlayerIdParam(params)
    const input = await parseJsonBody(req, consentActionSchema)
    const status = await recordWhatsAppConsent(actor, id, input, { requestId })
    return ok(status, {
      status: 201,
      message:
        input.action === "GRANTED"
          ? "Consentimiento registrado"
          : "Consentimiento revocado",
      requestId,
    })
  }
)
