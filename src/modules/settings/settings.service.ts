import "server-only"

import { OPERATIONAL_RULES } from "@/config/operational-rules"
import { NotFoundError } from "@/lib/errors"
import { getEnv } from "@/lib/env"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type {
  UpdateBusinessSettingsInput,
  UpdateCashBoxInput,
} from "@/modules/settings/settings.schemas"

/**
 * Configuración general, caja central, políticas operativas y estado de
 * WhatsApp. Ninguna función de este archivo crea saldos ni movimientos.
 */

const actorSelect = { select: { id: true, name: true } } as const

/** Si faltan los datos iniciales, el error indica cómo resolverlo. */
function missingSeed(what: string): never {
  throw new NotFoundError(
    `${what} no está inicializado. Ejecuta \`npm run db:seed\` (idempotente).`
  )
}

// ── Configuración general ─────────────────────────────────────────────

export type BusinessSettingsView = {
  businessName: string
  displayName: string | null
  logoUrl: string | null
  currency: string
  timezone: string
  dateFormat: "DD_MM_YYYY" | "YYYY_MM_DD"
  timeFormat: "H12" | "H24"
  updatedAt: string
  updatedBy: { id: string; name: string } | null
}

const businessSelect = {
  businessName: true,
  displayName: true,
  logoUrl: true,
  currency: true,
  timezone: true,
  dateFormat: true,
  timeFormat: true,
  updatedAt: true,
  updatedBy: actorSelect,
} as const

export async function getBusinessSettings(): Promise<BusinessSettingsView> {
  const settings = await prisma.businessSettings.findUnique({
    where: { id: 1 },
    select: businessSelect,
  })
  if (!settings) missingSeed("La configuración general")
  return { ...settings, updatedAt: settings.updatedAt.toISOString() }
}

export async function updateBusinessSettings(
  actor: SessionUser,
  input: UpdateBusinessSettingsInput,
  ctx: RequestContext = {}
): Promise<BusinessSettingsView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.businessSettings.findUnique({
      where: { id: 1 },
      select: businessSelect,
    })
    if (!before) missingSeed("La configuración general")

    const changes = diffChanges(before, input)
    const updated = await tx.businessSettings.update({
      where: { id: 1 },
      data: { ...input, updatedById: actor.id },
      select: businessSelect,
    })

    if (changes) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.BUSINESS_SETTINGS_UPDATED,
          entityType: "BusinessSettings",
          entityId: "1",
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: { changes },
        },
        tx
      )
    }

    return { ...updated, updatedAt: updated.updatedAt.toISOString() }
  })
}

// ── Caja central ──────────────────────────────────────────────────────

export type CashBoxView = {
  id: string
  code: string
  name: string
  currency: string
  isActive: boolean
  updatedAt: string
  updatedBy: { id: string; name: string } | null
}

const cashBoxSelect = {
  id: true,
  code: true,
  name: true,
  currency: true,
  isActive: true,
  updatedAt: true,
  updatedBy: actorSelect,
} as const

/** La caja financiera única (MAIN). No expone ni calcula saldos. */
export async function getCashBox(): Promise<CashBoxView> {
  const box = await prisma.cashBox.findUnique({
    where: { code: "MAIN" },
    select: cashBoxSelect,
  })
  if (!box) missingSeed("La Caja Central")
  return { ...box, updatedAt: box.updatedAt.toISOString() }
}

/** Solo el nombre es editable: código, moneda y estado son fijos en esta versión. */
export async function updateCashBox(
  actor: SessionUser,
  input: UpdateCashBoxInput,
  ctx: RequestContext = {}
): Promise<CashBoxView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.cashBox.findUnique({
      where: { code: "MAIN" },
      select: cashBoxSelect,
    })
    if (!before) missingSeed("La Caja Central")

    const updated = await tx.cashBox.update({
      where: { code: "MAIN" },
      data: { name: input.name, updatedById: actor.id },
      select: cashBoxSelect,
    })

    if (before.name !== input.name) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.CASH_BOX_UPDATED,
          entityType: "CashBox",
          entityId: before.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            changes: { name: { from: before.name, to: input.name } },
          },
        },
        tx
      )
    }

    return { ...updated, updatedAt: updated.updatedAt.toISOString() }
  })
}

// ── Políticas operativas ──────────────────────────────────────────────

export async function getOperationalSettings() {
  const settings = await prisma.operationalSettings.findUnique({
    where: { id: 1 },
    select: { initialCashPolicy: true, closingCashPolicy: true },
  })
  if (!settings) missingSeed("La configuración operativa")
  return { ...settings, rules: OPERATIONAL_RULES }
}

// ── WhatsApp (pendiente) ──────────────────────────────────────────────

export const WHATSAPP_PENDING_NOTICE =
  "El número nuevo exclusivo de Poker Manager está pendiente de recepción. " +
  "La configuración de WhatsApp deberá completarse posteriormente desde " +
  "Configuración → WhatsApp. No se necesitan datos reales para finalizar el Módulo 02."

export type WhatsAppStatusView = {
  provider: "META_CLOUD_API"
  configurationStatus: "PENDING_CONFIGURATION" | "CONFIGURED"
  enabled: boolean
  senderPhone: string | null
  phoneNumberId: string | null
  businessAccountId: string | null
  templatesStatus: "PENDING"
  lastVerifiedAt: string | null
  /** Solo indica si las variables de entorno existen; nunca expone su valor. */
  credentialsPresent: boolean
  notice: string
}

/** Estado de solo lectura. No conecta con Meta ni envía mensajes. */
export async function getWhatsAppStatus(): Promise<WhatsAppStatusView> {
  const settings = await prisma.whatsAppSettings.findUnique({
    where: { id: 1 },
  })
  if (!settings) missingSeed("La configuración de WhatsApp")

  const env = getEnv()
  return {
    provider: settings.provider,
    configurationStatus: settings.configurationStatus,
    enabled: settings.enabled,
    senderPhone: settings.senderPhone,
    phoneNumberId: settings.phoneNumberId,
    businessAccountId: settings.businessAccountId,
    templatesStatus: "PENDING",
    lastVerifiedAt: settings.lastVerifiedAt?.toISOString() ?? null,
    credentialsPresent: Boolean(
      env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
    ),
    notice: WHATSAPP_PENDING_NOTICE,
  }
}
