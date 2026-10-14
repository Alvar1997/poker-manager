import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { AppError, BusinessRuleError, NotFoundError } from "@/lib/errors"
import { formatPhone, maskPhone } from "@/lib/phone"
import { isUniqueViolation } from "@/lib/prisma-errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  recordAudit,
  type DbClient,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import { WHATSAPP_CONSENT_NOTICE_VERSION } from "@/modules/players/consent-notice"
import type {
  ConsentActionInput,
  ListPlayersQuery,
  UpdatePlayerInput,
} from "@/modules/players/player.schemas"

/**
 * Directorio de jugadores (Módulo 03).
 *
 * - Un jugador NO es un usuario: sin correo, contraseña ni rol.
 * - Teléfono E.164 único: la base lo garantiza (UNIQUE) y aquí se valida
 *   antes para dar un error claro; la violación de unicidad concurrente
 *   también se traduce a 409 (nunca dos registros).
 * - Sin deudas, saldos ni límites de crédito: no existen como campos; se
 *   derivarán de operaciones confirmadas en módulos posteriores.
 * - Sin borrado físico: solo activar/desactivar, que nunca toca deudas.
 * - Cambiar el teléfono guarda el anterior en PlayerPhoneHistory (en la
 *   misma transacción que el cambio y su auditoría).
 * - Consentimiento WhatsApp: historial de solo inserción; el VIGENTE es el
 *   registro más reciente si es GRANTED y corresponde al teléfono actual.
 * - Auditoría con el teléfono enmascarado; el número completo solo vive en
 *   el perfil y en el historial telefónico (acceso restringido).
 */

/**
 * Margen para iniciar/terminar transacciones. El `maxWait` predeterminado
 * de Prisma (2 s) es corto para Neon al "despertar" y para altas
 * simultáneas del mismo teléfono (las que esperan deben llegar a la
 * verificación de unicidad y responder 409, no agotar el tiempo).
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const

function playerTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(fn, TX_OPTIONS)
}

export type ConsentStatus = {
  /** true solo si el último registro es GRANTED y es para el teléfono actual. */
  granted: boolean
  /** Último registro (si existe), aunque ya no esté vigente. */
  lastAction: "GRANTED" | "REVOKED" | null
  lastRecordedAt: string | null
  noticeVersion: string | null
  /** El último consentimiento otorgado era para un teléfono anterior. */
  staleBecausePhoneChanged: boolean
}

export type PlayerView = {
  id: string
  name: string
  nickname: string | null
  phone: string
  phoneDisplay: string
  countryCode: string
  isActive: boolean
  notes: string | null
  whatsappConsent: ConsentStatus
  createdAt: string
  updatedAt: string
  createdBy: { id: string; name: string } | null
  updatedBy: { id: string; name: string } | null
}

export type PlayerListResult = {
  items: PlayerView[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const latestWhatsAppConsent = {
  where: { channel: "WHATSAPP" },
  orderBy: { recordedAt: "desc" },
  take: 1,
  select: {
    action: true,
    phone: true,
    noticeVersion: true,
    recordedAt: true,
  },
} satisfies Prisma.Player$consentsArgs

const playerSelect = {
  id: true,
  name: true,
  nickname: true,
  phone: true,
  countryCode: true,
  isActive: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  consents: latestWhatsAppConsent,
} satisfies Prisma.PlayerSelect

type PlayerRecord = Prisma.PlayerGetPayload<{ select: typeof playerSelect }>

export function deriveConsentStatus(
  currentPhone: string,
  latest:
    | {
        action: "GRANTED" | "REVOKED"
        phone: string
        noticeVersion: string
        recordedAt: Date
      }
    | undefined
): ConsentStatus {
  if (!latest) {
    return {
      granted: false,
      lastAction: null,
      lastRecordedAt: null,
      noticeVersion: null,
      staleBecausePhoneChanged: false,
    }
  }
  const samePhone = latest.phone === currentPhone
  return {
    granted: latest.action === "GRANTED" && samePhone,
    lastAction: latest.action,
    lastRecordedAt: latest.recordedAt.toISOString(),
    noticeVersion: latest.noticeVersion,
    staleBecausePhoneChanged: latest.action === "GRANTED" && !samePhone,
  }
}

function toView(p: PlayerRecord): PlayerView {
  return {
    id: p.id,
    name: p.name,
    nickname: p.nickname,
    phone: p.phone,
    phoneDisplay: formatPhone(p.phone),
    countryCode: p.countryCode,
    isActive: p.isActive,
    notes: p.notes,
    whatsappConsent: deriveConsentStatus(p.phone, p.consents[0]),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    createdBy: p.createdBy,
    updatedBy: p.updatedBy,
  }
}

// ── Consultas ─────────────────────────────────────────────────────────

/** Búsqueda en servidor y paginada (nunca descarga el directorio completo). */
export async function listPlayers(
  query: ListPlayersQuery
): Promise<PlayerListResult> {
  const where: Prisma.PlayerWhereInput = {}
  if (query.status === "active") where.isActive = true
  if (query.status === "inactive") where.isActive = false

  if (query.q) {
    const or: Prisma.PlayerWhereInput[] = [
      { name: { contains: query.q, mode: "insensitive" } },
      { nickname: { contains: query.q, mode: "insensitive" } },
    ]
    // Búsqueda por teléfono: por dígitos, en cualquier formato que se teclee.
    const digits = query.q.replace(/\D/g, "")
    if (digits.length >= 3) or.push({ phone: { contains: digits } })
    where.OR = or
  }

  const orderBy: Prisma.PlayerOrderByWithRelationInput[] = [
    { [query.sort]: query.order },
    { id: "asc" },
  ]

  const [total, players] = await prisma.$transaction([
    prisma.player.count({ where }),
    prisma.player.findMany({
      where,
      select: playerSelect,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ])

  return {
    items: players.map(toView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

export async function getPlayer(id: string): Promise<PlayerView> {
  const player = await prisma.player.findUnique({
    where: { id },
    select: playerSelect,
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  return toView(player)
}

// ── Duplicados ────────────────────────────────────────────────────────

export const DUPLICATE_PHONE_MESSAGE =
  "Ya existe un jugador registrado con ese teléfono"

/**
 * 409 con referencia al jugador existente (solo id y nombre) para que el
 * cajero lo consulte. Si quien llama no puede consultar jugadores, no se
 * revela nada más que el conflicto.
 */
function duplicatePhone(existing: { id: string; name: string } | null) {
  return new AppError(
    "CONFLICT",
    DUPLICATE_PHONE_MESSAGE,
    existing ? { field: "phone", existingPlayer: existing } : { field: "phone" }
  )
}

async function findByPhone(db: DbClient, phone: string) {
  return db.player.findUnique({
    where: { phone },
    select: { id: true, name: true },
  })
}

/** Para la violación UNIQUE capturada FUERA de la transacción (carrera). */
async function duplicateError(phone: string, revealExisting: boolean) {
  const existing = revealExisting ? await findByPhone(prisma, phone) : null
  return duplicatePhone(existing)
}

// ── Alta ──────────────────────────────────────────────────────────────

export type CreatePlayerData = {
  name: string
  nickname?: string | null
  phone: string
  countryCode: string
  notes?: string | null
  whatsappConsent?: {
    noticeVersion: string
    source: "IN_PERSON" | "ADMIN_ENTRY"
    confirmedByPlayer: true
    evidenceReference?: string | null
    notes?: string | null
  }
}

export async function createPlayer(
  actor: SessionUser,
  input: CreatePlayerData,
  ctx: RequestContext & { revealExisting?: boolean } = {}
): Promise<PlayerView> {
  try {
    const id = await playerTx(async (tx) => {
      const existing = await findByPhone(tx, input.phone)
      if (existing) {
        throw duplicatePhone(ctx.revealExisting ? existing : null)
      }

      const created = await tx.player.create({
        data: {
          name: input.name,
          nickname: input.nickname ?? null,
          phone: input.phone,
          countryCode: input.countryCode,
          notes: input.notes ?? null,
          createdById: actor.id,
          updatedById: actor.id,
        },
        select: { id: true },
      })

      await recordAudit(
        {
          action: AUDIT_ACTIONS.PLAYER_CREATED,
          entityType: "Player",
          entityId: created.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            name: input.name,
            nickname: input.nickname ?? null,
            phone: maskPhone(input.phone),
            hasNotes: Boolean(input.notes),
            whatsappConsent: Boolean(input.whatsappConsent),
          },
        },
        tx
      )

      // WA-04: el consentimiento solo existe si se marcó explícitamente.
      if (input.whatsappConsent) {
        await insertConsent(
          tx,
          actor,
          created.id,
          input.phone,
          {
            action: "GRANTED",
            ...input.whatsappConsent,
          },
          ctx
        )
      }

      return created.id
    })
    return getPlayer(id)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw await duplicateError(input.phone, ctx.revealExisting ?? false)
    }
    throw error
  }
}

// ── Edición ───────────────────────────────────────────────────────────

export async function updatePlayer(
  actor: SessionUser,
  id: string,
  input: UpdatePlayerInput,
  ctx: RequestContext & { revealExisting?: boolean } = {}
): Promise<PlayerView> {
  try {
    await playerTx(async (tx) => {
      const before = await tx.player.findUnique({
        where: { id },
        select: { name: true, nickname: true, phone: true, notes: true },
      })
      if (!before) throw new NotFoundError("Jugador no encontrado")

      const phoneChanges =
        input.phone !== undefined && input.phone !== before.phone

      if (phoneChanges) {
        const other = await findByPhone(tx, input.phone!)
        if (other && other.id !== id) {
          throw duplicatePhone(ctx.revealExisting ? other : null)
        }
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {}
      if (input.name !== undefined && input.name !== before.name) {
        changes.name = { from: before.name, to: input.name }
      }
      if (input.nickname !== undefined && input.nickname !== before.nickname) {
        changes.nickname = { from: before.nickname, to: input.nickname }
      }
      const notesChanged =
        input.notes !== undefined && input.notes !== before.notes

      if (!phoneChanges && Object.keys(changes).length === 0 && !notesChanged) {
        return
      }

      await tx.player.update({
        where: { id },
        data: {
          name: input.name,
          nickname: input.nickname,
          notes: input.notes,
          ...(phoneChanges
            ? { phone: input.phone, countryCode: input.countryCode }
            : {}),
          updatedById: actor.id,
        },
      })

      if (Object.keys(changes).length > 0 || notesChanged) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.PLAYER_UPDATED,
            entityType: "Player",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            // Las notas pueden ser sensibles: se registra que cambiaron,
            // no su contenido.
            metadata: { changes, notesChanged },
          },
          tx
        )
      }

      if (phoneChanges) {
        await tx.playerPhoneHistory.create({
          data: {
            playerId: id,
            previousPhone: before.phone,
            newPhone: input.phone!,
            reason: input.phoneChangeReason ?? null,
            changedById: actor.id,
          },
        })
        await recordAudit(
          {
            action: AUDIT_ACTIONS.PLAYER_PHONE_CHANGED,
            entityType: "Player",
            entityId: id,
            actorUserId: actor.id,
            requestId: ctx.requestId,
            metadata: {
              from: maskPhone(before.phone),
              to: maskPhone(input.phone!),
              reason: input.phoneChangeReason ?? null,
              // El consentimiento previo era para el número anterior.
              whatsappConsentNoLongerApplies: true,
            },
          },
          tx
        )
      }
    })
  } catch (error) {
    if (isUniqueViolation(error) && input.phone) {
      throw await duplicateError(input.phone, ctx.revealExisting ?? false)
    }
    throw error
  }

  return getPlayer(id)
}

// ── Estado ────────────────────────────────────────────────────────────

/** Desactivar no borra nada ni toca deudas; reactivar es posible. */
export async function setPlayerStatus(
  actor: SessionUser,
  id: string,
  isActive: boolean,
  reason: string | null | undefined,
  ctx: RequestContext = {}
): Promise<PlayerView> {
  await playerTx(async (tx) => {
    const current = await tx.player.findUnique({
      where: { id },
      select: { isActive: true },
    })
    if (!current) throw new NotFoundError("Jugador no encontrado")
    if (current.isActive === isActive) return

    await tx.player.update({
      where: { id },
      data: { isActive, updatedById: actor.id },
    })
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PLAYER_STATUS_CHANGED,
        entityType: "Player",
        entityId: id,
        actorUserId: actor.id,
        requestId: ctx.requestId,
        metadata: {
          from: current.isActive ? "ACTIVE" : "INACTIVE",
          to: isActive ? "ACTIVE" : "INACTIVE",
          reason: reason ?? null,
        },
      },
      tx
    )
  })
  return getPlayer(id)
}

// ── Consentimiento ────────────────────────────────────────────────────

type ConsentRecordInput = {
  action: "GRANTED" | "REVOKED"
  source: "IN_PERSON" | "ADMIN_ENTRY"
  noticeVersion?: string
  evidenceReference?: string | null
  notes?: string | null
}

async function insertConsent(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  playerId: string,
  phone: string,
  input: ConsentRecordInput,
  ctx: RequestContext
) {
  const record = await tx.playerNotificationConsent.create({
    data: {
      playerId,
      channel: "WHATSAPP",
      consentType: "TRANSACTIONAL",
      action: input.action,
      phone,
      // En una revocación se conserva la versión vigente como referencia.
      noticeVersion: input.noticeVersion ?? WHATSAPP_CONSENT_NOTICE_VERSION,
      source: input.source,
      evidenceReference: input.evidenceReference ?? null,
      notes: input.notes ?? null,
      recordedById: actor.id,
    },
    select: { id: true },
  })
  await recordAudit(
    {
      action:
        input.action === "GRANTED"
          ? AUDIT_ACTIONS.PLAYER_WHATSAPP_CONSENT_GRANTED
          : AUDIT_ACTIONS.PLAYER_WHATSAPP_CONSENT_REVOKED,
      entityType: "Player",
      entityId: playerId,
      actorUserId: actor.id,
      requestId: ctx.requestId,
      metadata: {
        consentRecordId: record.id,
        channel: "WHATSAPP",
        noticeVersion: input.noticeVersion ?? WHATSAPP_CONSENT_NOTICE_VERSION,
        source: input.source,
        phone: maskPhone(phone),
      },
    },
    tx
  )
}

/**
 * Registra una aceptación o revocación. Bloquea la fila del jugador para
 * que dos registros simultáneos no se contradigan. Otorgar cuando ya hay
 * consentimiento vigente (o revocar cuando no lo hay) es un error de
 * negocio: no se generan eventos redundantes.
 */
export async function recordWhatsAppConsent(
  actor: SessionUser,
  playerId: string,
  input: ConsentActionInput,
  ctx: RequestContext = {}
): Promise<ConsentStatus> {
  await playerTx(async (tx) => {
    const locked = await tx.$queryRaw<{ phone: string }[]>`
      SELECT "phone" FROM "players" WHERE "id" = ${playerId} FOR UPDATE
    `
    const phone = locked[0]?.phone
    if (!phone) throw new NotFoundError("Jugador no encontrado")

    const latest = await tx.playerNotificationConsent.findFirst({
      ...latestWhatsAppConsent,
      where: { playerId, channel: "WHATSAPP" },
    })
    const current = deriveConsentStatus(phone, latest ?? undefined)

    if (input.action === "GRANTED" && current.granted) {
      throw new BusinessRuleError("El jugador ya tiene consentimiento vigente")
    }
    if (input.action === "REVOKED" && !current.granted) {
      throw new BusinessRuleError(
        "El jugador no tiene un consentimiento vigente que revocar"
      )
    }

    await insertConsent(tx, actor, playerId, phone, input, ctx)
  })

  return getConsentStatus(playerId)
}

export async function getConsentStatus(
  playerId: string
): Promise<ConsentStatus> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { phone: true, consents: latestWhatsAppConsent },
  })
  if (!player) throw new NotFoundError("Jugador no encontrado")
  return deriveConsentStatus(player.phone, player.consents[0])
}

export type ConsentHistoryEntry = {
  id: string
  action: "GRANTED" | "REVOKED"
  noticeVersion: string
  source: "IN_PERSON" | "ADMIN_ENTRY"
  phoneMasked: string
  evidenceReference: string | null
  notes: string | null
  recordedAt: string
  recordedBy: { id: string; name: string } | null
}

export async function getConsentHistory(
  playerId: string
): Promise<ConsentHistoryEntry[]> {
  await assertPlayerExists(playerId)
  const records = await prisma.playerNotificationConsent.findMany({
    where: { playerId, channel: "WHATSAPP" },
    orderBy: { recordedAt: "desc" },
    take: 100,
    select: {
      id: true,
      action: true,
      noticeVersion: true,
      source: true,
      phone: true,
      evidenceReference: true,
      notes: true,
      recordedAt: true,
      recordedBy: { select: { id: true, name: true } },
    },
  })
  return records.map(({ phone, recordedAt, ...r }) => ({
    ...r,
    phoneMasked: maskPhone(phone),
    recordedAt: recordedAt.toISOString(),
  }))
}

// ── Historial restringido ─────────────────────────────────────────────

export type PhoneHistoryEntry = {
  id: string
  previousPhone: string
  newPhone: string
  reason: string | null
  changedAt: string
  changedBy: { id: string; name: string } | null
}

export async function getPhoneHistory(
  playerId: string
): Promise<PhoneHistoryEntry[]> {
  await assertPlayerExists(playerId)
  const rows = await prisma.playerPhoneHistory.findMany({
    where: { playerId },
    orderBy: { changedAt: "desc" },
    take: 100,
    select: {
      id: true,
      previousPhone: true,
      newPhone: true,
      reason: true,
      changedAt: true,
      changedBy: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({ ...r, changedAt: r.changedAt.toISOString() }))
}

export type PlayerAuditEntry = {
  id: string
  action: string
  result: "SUCCESS" | "FAILURE" | "DENIED"
  createdAt: string
  actor: { id: string; name: string } | null
  metadata: unknown
}

/** Solo eventos del jugador; metadatos ya sanitizados y con teléfonos enmascarados. */
export async function getPlayerAudit(
  playerId: string
): Promise<PlayerAuditEntry[]> {
  await assertPlayerExists(playerId)
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "Player", entityId: playerId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      action: true,
      result: true,
      createdAt: true,
      metadata: true,
      actor: { select: { id: true, name: true } },
    },
  })
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

async function assertPlayerExists(id: string) {
  const exists = await prisma.player.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!exists) throw new NotFoundError("Jugador no encontrado")
}
