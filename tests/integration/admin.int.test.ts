import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "pg"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import * as auditRoute from "@/app/api/admin/audit/route"
import * as backupsRoute from "@/app/api/admin/backups/route"
import * as correctionApproveRoute from "@/app/api/admin/corrections/[id]/approve/route"
import * as correctionsRoute from "@/app/api/admin/corrections/route"
import * as healthRoute from "@/app/api/admin/system/health/route"
import * as incidentsRoute from "@/app/api/admin/incidents/route"
import * as recoveryRoute from "@/app/api/admin/recovery/route"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { recordAudit } from "@/modules/audit/audit.service"
import { getBackupConfig } from "@/modules/backups/backup.config"
import { runBackup, verifyBackup } from "@/modules/backups/backup.service"
import {
  approveRecovery,
  executeRecovery,
  requestRecovery,
  setMaintenance,
} from "@/modules/backups/recovery.service"
import { runRestoreTest } from "@/modules/backups/restore.service"
import {
  createCorrection,
  decideCorrection,
  getCorrection,
  linkExecution,
} from "@/modules/corrections/correction.service"
import {
  registerPayment,
  reversePayment,
} from "@/modules/credits/receivable-payment.service"
import { updateIncident } from "@/modules/incidents/incident.service"
import { runIntegrityCheck } from "@/modules/integrity/integrity.service"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import {
  confirmDelivery,
  createPurchase,
  getPurchase,
  recordCreditAuthorization,
} from "@/modules/purchases/purchase.service"
import { addPlayerToTable } from "@/modules/session-tables/participation.service"
import { openSessionTable } from "@/modules/session-tables/session-table.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  createSession,
  prepareSession,
} from "@/modules/sessions/session.service"
import {
  captureSignature,
  prepareSignatureSummary,
} from "@/modules/signatures/signature.service"

import {
  auditRows,
  call,
  createTestPlayer,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
  TEST_PASSWORD,
} from "./helpers"
import { resolveTestDatabaseUrl } from "./test-db"

/**
 * Módulo 15 contra PostgreSQL REAL: auditoría atómica e inmutable,
 * correcciones (sin efectos monetarios al aprobar), integridad con
 * inconsistencias inyectadas SOLO en la base de pruebas, incidencias,
 * respaldo REAL (cifrado + verificación), prueba de restauración REAL en
 * una base aislada y recuperación protegida REAL en una base NUEVA.
 */

type Role = "SUPERADMIN" | "PARTNER" | "CASHIER"
async function actorFor(role: Role) {
  const u = await createUser({ role })
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
    _user: u,
  }
}
type Actor = Awaited<ReturnType<typeof actorFor>>
const key = () => randomUUID()
const STROKES: [number, number][][] = [
  Array.from({ length: 40 }, (_, i): [number, number] => [
    100 + i * 20,
    Math.round(200 + 120 * Math.sin(i / 3)),
  ]),
  Array.from({ length: 15 }, (_, i): [number, number] => [150 + i * 50, 360]),
]

const SOURCE = resolveTestDatabaseUrl()
const withDb = (name: string) => {
  const u = new URL(SOURCE)
  u.pathname = `/${name}`
  return u.toString()
}
const RESTORE_DB = withDb("poker_m15_restore_test")
const RECOVERY_DB = withDb("poker_m15_recovery")

async function recreateDatabase(name: string) {
  const admin = new Client({ connectionString: withDb("postgres") })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }
}

let cashier: Actor
let partner: Actor
let partner2: Actor
let admin: Actor
let sessionId: string
let t25: string
let denominationId: string
let storageDir: string
const ENV_KEYS = [
  "BACKUP_STORAGE_DIR",
  "BACKUP_ENCRYPTION_KEY",
  "BACKUP_SOURCE_DATABASE_URL",
  "RESTORE_TEST_DATABASE_URL",
  "RECOVERY_TARGET_DATABASE_URL",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

function configureBackups() {
  process.env.BACKUP_STORAGE_DIR = storageDir
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64")
  process.env.BACKUP_SOURCE_DATABASE_URL = SOURCE
  process.env.RESTORE_TEST_DATABASE_URL = RESTORE_DB
  process.env.RECOVERY_TARGET_DATABASE_URL = RECOVERY_DB
}

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

async function openRealSession() {
  const s = await createSession(cashier, { idempotencyKey: key() })
  await prepareSession(cashier, s.id)
  const { count } = await createOpeningChipCount(cashier, s.id)
  await updateStockCount(cashier, count.id, {
    lines: count.details.map((x) => ({
      denominationId: x.denominationId,
      countedQuantity: x.expectedQuantity,
    })),
  })
  await confirmStockCount(cashier, count.id, key())
  await confirmOpeningCashCount(cashier, s.id, {
    countedAmount: "0",
    physicallyVerified: true,
  })
  await openSession(cashier, s.id, { idempotencyKey: key() })
  return s.id
}

async function creditBuy(participationId: string, amount: string) {
  const { purchaseId } = await createPurchase(cashier, {
    participationId,
    nominalAmount: amount,
    idempotencyKey: key(),
  })
  await recordCreditAuthorization(cashier, purchaseId, {
    partnerId: partner.id,
    channel: "VERBAL",
    idempotencyKey: key(),
  })
  const prepared = await prepareSignatureSummary(cashier, purchaseId)
  await captureSignature(cashier, purchaseId, {
    snapshotId: prepared.summary.snapshotId,
    payloadHash: prepared.summary.payloadHash,
    strokes: STROKES,
    idempotencyKey: key(),
  })
  const p = await getPurchase(purchaseId)
  await confirmDelivery(cashier, purchaseId, {
    expectedVersion: p.version,
    physicalDeliveryConfirmed: true,
    idempotencyKey: key(),
  })
  return purchaseId
}

/** Escenario real: un jugador con compra a crédito de $3,000 y un abono en efectivo de $1,000. */
async function scenario() {
  sessionId = await openRealSession()
  await openSessionTable(cashier, sessionId, t25, { idempotencyKey: key() })
  const playerId = (await createTestPlayer({ name: "Jugador M15" })).id
  const { participationId } = await addPlayerToTable(cashier, sessionId, t25, {
    playerId,
    idempotencyKey: key(),
  })
  const purchaseId = await creditBuy(participationId, "3000")
  const { paymentId } = await registerPayment(cashier, {
    playerId,
    amount: "1000",
    origin: "SESSION",
    method: "CASH",
    cashReceived: true,
    idempotencyKey: key(),
  } as Parameters<typeof registerPayment>[1])
  return { playerId, purchaseId, paymentId }
}

const money = async () => ({
  tx: await prisma.cashTransaction.count(),
  entries: await prisma.cashTransactionEntry.count(),
  alloc: await prisma.paymentAllocation.count(),
  chips: await prisma.chipNominalMovement.count(),
})

beforeEach(async () => {
  await resetDatabase()
  const shared = await prisma.chipSet.findUniqueOrThrow({
    where: { code: "CHIPSET_MAIN" },
  })
  denominationId = (
    await prisma.chipDenomination.create({
      data: { chipSetId: shared.id, value: "500" },
    })
  ).id
  cashier = await actorFor("CASHIER")
  partner = await actorFor("PARTNER")
  partner2 = await actorFor("PARTNER")
  admin = await actorFor("SUPERADMIN")
  await initializeStock(cashier, {
    chipSetId: shared.id,
    lines: [{ denominationId, quantity: 100 }],
    idempotencyKey: key(),
  })
  t25 = (
    await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
  ).id
  storageDir = await mkdtemp(join(tmpdir(), "pm-m15-"))
  for (const k of ENV_KEYS) delete process.env[k]
})

describe("auditoría transversal", () => {
  it("registra actor, rol del momento, módulo, sesión e importe; es atómica e inmutable", async () => {
    const s = await scenario()
    const [delivered] = await auditRows("PURCHASE_CONFIRMED")
    expect(delivered).toMatchObject({
      actorUserId: cashier.id,
      actorRole: "CASHIER",
      module: "PURCHASES",
      entityId: s.purchaseId,
    })
    expect(delivered.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    // Atomicidad: si la transacción falla, el evento no queda.
    const before = await prisma.auditLog.count()
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(
          { action: "INCIDENT_CREATED", entityType: "Test" },
          tx
        )
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")
    expect(await prisma.auditLog.count()).toBe(before)
    // Inmutabilidad en la base (no existe endpoint, y además el trigger lo impide).
    await expect(
      prisma.auditLog.update({
        where: { id: delivered.id },
        data: { action: "X" },
      })
    ).rejects.toThrow()
    await expect(
      prisma.auditLog.delete({ where: { id: delivered.id } })
    ).rejects.toThrow()
  })

  it("los tres roles consultan; seguridad e infraestructura quedan fuera de la autorización general", async () => {
    await scenario()
    await recordAudit({
      action: "AUTH_LOGIN_FAILED",
      entityType: "User",
      metadata: { reason: "x" },
    })
    await recordAudit({
      action: "BACKUP_FAILED",
      entityType: "BackupExecution",
    })
    for (const [actor, sees] of [
      [cashier, false],
      [partner, false],
      [admin, true],
    ] as const) {
      signInAs(actor._user)
      const r = await call(auditRoute.GET, {
        path: "/api/admin/audit?pageSize=100",
      })
      expect(r.status).toBe(200)
      const actions = (
        r.json.data as { items: { action: string }[] }
      ).items.map((i) => i.action)
      expect(actions).toContain("PURCHASE_CONFIRMED")
      expect(actions.includes("AUTH_LOGIN_FAILED")).toBe(sees)
      expect(actions.includes("BACKUP_FAILED")).toBe(actor.role !== "CASHIER")
    }
    signInAs(cashier._user)
    const bySession = await call(auditRoute.GET, {
      path: `/api/admin/audit?sessionId=${sessionId}`,
    })
    expect((bySession.json.data as { total: number }).total).toBeGreaterThan(3)
    signOut()
    expect(
      (await call(auditRoute.GET, { path: "/api/admin/audit" })).status
    ).toBe(401)
  })
})

describe("correcciones excepcionales", () => {
  it("CASHIER solicita; no autoriza; PARTNER aprueba SIN movimientos; el Módulo 16 solo enlaza un reverso ejecutado real", async () => {
    const s = await scenario()
    const req = await createCorrection(cashier, {
      type: "PURCHASE_REVERSAL",
      targetType: "ChipPurchase",
      targetId: s.purchaseId,
      reason: "Compra capturada al jugador equivocado",
      idempotencyKey: key(),
    })
    const replay = await createCorrection(cashier, {
      type: "PURCHASE_REVERSAL",
      targetType: "ChipPurchase",
      targetId: s.purchaseId,
      reason: "Compra capturada al jugador equivocado",
      idempotencyKey: (
        await prisma.correctionRequest.findUniqueOrThrow({
          where: { id: req.id },
        })
      ).idempotencyKey,
    })
    expect(replay).toMatchObject({ id: req.id, replayed: true })
    await expect(
      createCorrection(cashier, {
        type: "PURCHASE_REVERSAL",
        targetType: "ChipPurchase",
        targetId: s.purchaseId,
        reason: "Otra solicitud igual",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(/activa/)
    // CASHIER no autoriza (servicio y endpoint).
    await expect(
      decideCorrection(cashier, req.id, "APPROVED", {
        expectedVersion: 1,
        notes: "yo apruebo",
      })
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    signInAs(cashier._user)
    const denied = await call(correctionApproveRoute.POST, {
      method: "POST",
      path: `/api/admin/corrections/${req.id}/approve`,
      params: { id: req.id },
      body: { expectedVersion: 1, notes: "intento" },
    })
    expect(denied.status).toBe(403)
    // PARTNER aprueba: ningún movimiento financiero ni de fichas.
    const before = await money()
    await decideCorrection(partner, req.id, "APPROVED", {
      expectedVersion: 1,
      notes: "Procede, pendiente del Módulo 16",
    })
    expect(await money()).toEqual(before)
    const c = await getCorrection(req.id)
    expect(c.status).toBe("APPROVED")
    expect(c.statusLabel).toMatch(/pendiente de ejecución.*Módulo 16/)
    await expect(
      linkExecution(partner, req.id, {
        expectedVersion: c.version,
        referenceId: "x",
      })
    ).rejects.toThrow(/no es el reverso ejecutado/)
    expect((await getCorrection(req.id)).status).toBe("APPROVED")
    const [audit] = await auditRows("CORRECTION_APPROVED")
    expect(audit.metadata).toMatchObject({ financialEffect: "NONE" })
  })

  it("SUPERADMIN autoriza; la ejecución solo se marca al enlazar el reverso REAL; doble decisión imposible", async () => {
    const s = await scenario()
    const req = await createCorrection(cashier, {
      type: "RECEIVABLE_PAYMENT_REVERSAL",
      targetType: "ReceivablePayment",
      targetId: s.paymentId,
      reason: "Abono registrado dos veces por error",
      idempotencyKey: key(),
    })
    // Dos autorizadores a la vez: solo una decisión.
    const results = await Promise.allSettled([
      decideCorrection(admin, req.id, "APPROVED", {
        expectedVersion: 1,
        notes: "Aprobado por SUPERADMIN",
      }),
      decideCorrection(partner, req.id, "REJECTED", {
        expectedVersion: 1,
        notes: "Rechazado por socio",
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await prisma.correctionApproval.count()).toBe(1)
    let c = await getCorrection(req.id)
    if (c.status === "REJECTED") return // el socio ganó la carrera: estado coherente.
    expect(c.status).toBe("APPROVED")
    // Una referencia que no es el reverso real se rechaza.
    await expect(
      linkExecution(admin, req.id, {
        expectedVersion: c.version,
        referenceId: s.paymentId,
      })
    ).rejects.toThrow(/no es un reverso real/)
    // Ejecución legítima en su módulo (Módulo 10) y enlace verificado.
    await reversePayment(cashier, s.paymentId, {
      reason: "Abono duplicado (corrección aprobada)",
      idempotencyKey: key(),
    })
    const reversal = await prisma.receivablePaymentReversal.findUniqueOrThrow({
      where: { paymentId: s.paymentId },
    })
    await linkExecution(admin, req.id, {
      expectedVersion: c.version,
      referenceId: reversal.id,
    })
    c = await getCorrection(req.id)
    expect(c.status).toBe("EXECUTED")
    expect(c.executionReference).toMatchObject({
      id: reversal.id,
      executedBy: { id: cashier.id },
    })
    expect(c.decision?.decidedBy.id).toBe(admin.id)
    expect(c.requestedBy.id).toBe(cashier.id)
    // EXECUTED es terminal (trigger).
    await expect(
      prisma.correctionRequest.update({
        where: { id: req.id },
        data: { status: "CANCELLED" },
      })
    ).rejects.toThrow()
  })

  it("evita la autoaprobación cuando existe otro autorizador", async () => {
    const s = await scenario()
    const req = await createCorrection(partner, {
      type: "PURCHASE_REVERSAL",
      targetType: "ChipPurchase",
      targetId: s.purchaseId,
      reason: "Solicitud del propio socio",
      idempotencyKey: key(),
    })
    await expect(
      decideCorrection(partner, req.id, "APPROVED", {
        expectedVersion: 1,
        notes: "me apruebo",
      })
    ).rejects.toThrow(/propia solicitud/)
    await decideCorrection(partner2, req.id, "APPROVED", {
      expectedVersion: 1,
      notes: "Aprobada por otro socio",
    })
  })
})

describe("integridad e incidencias", () => {
  it("datos coherentes: sin errores; las deudas pendientes no son error ni abren incidencias", async () => {
    await scenario()
    const r = await runIntegrityCheck(cashier, { trigger: "MANUAL" })
    expect(r.summary.error).toBe(0)
    expect(r.summary.notEvaluated).toBe(0)
    expect(r.incidents.opened).toBe(0)
    const info = await prisma.integrityFinding.findFirstOrThrow({
      where: { runId: r.runId, checkCode: "RECEIVABLES_PENDING_INFO" },
    })
    expect(info.status).toBe("OK")
    expect(await prisma.operationalIncident.count()).toBe(0)
    // Una sola ejecución a la vez.
    await prisma.integrityCheckRun.create({ data: { trigger: "MANUAL" } })
    await expect(
      runIntegrityCheck(cashier, { trigger: "MANUAL" })
    ).rejects.toThrow(/en curso/)
  })

  it("detecta saldo incorrecto y evidencia alterada; abre incidencias críticas sin duplicarlas y sin corregir", async () => {
    await scenario()
    // Inyección SOLO en la base de pruebas (replica: sin triggers).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$executeRaw`UPDATE "financial_account_balances" SET "balance" = "balance" + 77
        WHERE "scopeKey" = ${sessionId} AND "accountId" = (SELECT "id" FROM "financial_accounts" WHERE "kind" = 'CASH_ON_HAND')`
      await tx.$executeRaw`UPDATE "evidence_blobs" SET "bytes" = decode('00', 'hex')`
    })
    const first = await runIntegrityCheck(partner, { trigger: "MANUAL" })
    const codes = (
      await prisma.integrityFinding.findMany({
        where: { runId: first.runId, status: "ERROR" },
      })
    ).map((f) => f.checkCode)
    expect(codes).toEqual(
      expect.arrayContaining([
        "CASH_PROJECTION_MATCHES_LEDGER",
        "EVIDENCE_INTEGRITY",
      ])
    )
    const opened = await prisma.operationalIncident.count()
    expect(opened).toBeGreaterThanOrEqual(2)
    expect(
      await prisma.operationalIncident.count({
        where: { severity: "CRITICAL" },
      })
    ).toBe(opened)
    // El diagnóstico NO corrigió nada.
    const bal = await prisma.financialAccountBalance.findFirstOrThrow({
      where: { scopeKey: sessionId, account: { kind: "CASH_ON_HAND" } },
    })
    expect(new Prisma.Decimal(bal.balance).toFixed(2)).toBe("1077.00")
    // Repetir el diagnóstico no duplica incidencias: registra la recurrencia.
    await runIntegrityCheck(partner, { trigger: "MANUAL" })
    expect(await prisma.operationalIncident.count()).toBe(opened)
    const inc = await prisma.operationalIncident.findFirstOrThrow({
      where: { title: { startsWith: "CASH_PROJECTION" } },
    })
    expect(inc.occurrences).toBe(2)
    // CASHIER no resuelve; PARTNER sí, con resolución; el historial se conserva.
    await expect(
      updateIncident(
        cashier,
        inc.id,
        {
          expectedVersion: inc.version,
          status: "RESOLVED",
          resolution: "Corregido",
        },
        { canResolve: false }
      )
    ).rejects.toThrow(/PARTNER o SUPERADMIN/)
    await updateIncident(
      cashier,
      inc.id,
      {
        expectedVersion: inc.version,
        comment: "Revisando con el socio",
        assignedToId: partner.id,
      },
      { canResolve: false }
    )
    const v = (
      await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: inc.id },
      })
    ).version
    await updateIncident(
      partner,
      inc.id,
      {
        expectedVersion: v,
        status: "RESOLVED",
        resolution: "Proyección corregida con ajuste documentado",
      },
      { canResolve: true }
    )
    const hist = await prisma.incidentHistory.findMany({
      where: { incidentId: inc.id },
      orderBy: { createdAt: "asc" },
    })
    expect(hist.map((h) => h.kind)).toEqual(
      expect.arrayContaining([
        "CREATED",
        "REOCCURRED",
        "ASSIGNED",
        "COMMENT",
        "STATUS_CHANGED",
      ])
    )
    await expect(
      prisma.operationalIncident.delete({ where: { id: inc.id } })
    ).rejects.toThrow()
    await expect(
      prisma.incidentHistory.deleteMany({ where: { incidentId: inc.id } })
    ).rejects.toThrow()
  })

  it("endpoints: los tres roles registran incidencias; infraestructura protegida por rol", async () => {
    signInAs(cashier._user)
    const created = await call(incidentsRoute.POST, {
      method: "POST",
      path: "/api/admin/incidents",
      body: {
        title: "Faltante reportado",
        description: "El cajero reporta un faltante en la mesa 25/25",
        severity: "HIGH",
      },
    })
    expect(created.status).toBe(201)
    expect(
      (await call(backupsRoute.GET, { path: "/api/admin/backups" })).status
    ).toBe(403)
    expect(
      (await call(healthRoute.GET, { path: "/api/admin/system/health" })).status
    ).toBe(403)
    expect(
      (await call(recoveryRoute.GET, { path: "/api/admin/recovery" })).status
    ).toBe(403)
    signInAs(partner._user)
    expect(
      (await call(backupsRoute.GET, { path: "/api/admin/backups" })).status
    ).toBe(200)
    const health = await call(healthRoute.GET, {
      path: "/api/admin/system/health",
    })
    expect(health.status).toBe(200)
    expect(JSON.stringify(health.json)).not.toMatch(
      /postgres:\/\/|postgresql:\/\/|BACKUP_ENCRYPTION_KEY=/
    )
    expect(
      (await call(recoveryRoute.GET, { path: "/api/admin/recovery" })).status
    ).toBe(403)
    // Un acceso administrativo denegado abre una incidencia de seguridad (sin duplicarse).
    await call(recoveryRoute.GET, { path: "/api/admin/recovery" })
    expect(
      await prisma.operationalIncident.count({ where: { source: "SECURITY" } })
    ).toBe(2) // cajero + socio
    signInAs(admin._user)
    expect(
      (await call(recoveryRoute.GET, { path: "/api/admin/recovery" })).status
    ).toBe(200)
    signInAs(cashier._user)
    const corr = await call(correctionsRoute.GET, {
      path: "/api/admin/corrections",
    })
    expect(corr.status).toBe(200)
  })
})

describe("respaldos, restauración aislada y recuperación protegida (reales)", () => {
  it("sin configuración no se ejecuta ni se registra un éxito falso", async () => {
    const r = await runBackup({ trigger: "SCHEDULED" })
    expect(r).toMatchObject({ status: "NOT_CONFIGURED" })
    expect(await prisma.backupExecution.count()).toBe(0)
    const t = await runRestoreTest({ trigger: "MANUAL" })
    expect(t.status).toBe("NOT_CONFIGURED")
  })

  it("respaldo diario real: manifiesto, checksums, evidencias ligadas a firmas; idempotente; alteración detectada", async () => {
    const s = await scenario()
    configureBackups()
    const r = await runBackup({ trigger: "SCHEDULED" })
    expect(r.status).toBe("SUCCESS")
    const b = await prisma.backupExecution.findUniqueOrThrow({
      where: { id: (r as { backupId: string }).backupId },
      include: { artifacts: true },
    })
    expect(b).toMatchObject({
      verificationStatus: "PASSED",
      destination: "filesystem",
      keyFingerprint: getBackupConfig().keyFingerprint,
    })
    expect(b.recoveryPoint).not.toBeNull()
    expect(b.artifacts.map((a) => a.kind).sort()).toEqual([
      "DATABASE_SNAPSHOT",
      "MANIFEST",
    ])
    const manifest = JSON.parse(
      await readFile(
        join(storageDir, b.artifacts.find((a) => a.kind === "MANIFEST")!.path),
        "utf8"
      )
    )
    expect(manifest.tables.chip_purchases.rows).toBe(1)
    expect(manifest.evidence.count).toBe(1)
    expect(manifest.evidence.files[0]).toMatchObject({
      purchaseId: s.purchaseId,
      purpose: "PURCHASE_SIGNATURE",
    })
    expect(manifest.evidence.files[0].signatureId).toBeTruthy()
    expect(manifest.evidence.files[0].actualSha256).toBe(
      manifest.evidence.files[0].sha256
    )
    const raw = JSON.stringify(manifest)
    expect(raw).not.toContain(process.env.BACKUP_ENCRYPTION_KEY!)
    expect(raw).not.toMatch(/postgres(ql)?:\/\//)
    // Un segundo respaldo diario el mismo día no se duplica.
    expect(await runBackup({ trigger: "SCHEDULED" })).toMatchObject({
      status: "SKIPPED",
      backupId: b.id,
    })
    // Alterar el artefacto: la verificación falla, se registra y abre incidencia.
    const file = join(storageDir, b.location!)
    await chmod(file, 0o600)
    const bytes = await readFile(file)
    bytes[bytes.length - 30] ^= 0xff
    await writeFile(file, bytes)
    const v = await verifyBackup(b.id, admin.id)
    expect(v.ok).toBe(false)
    expect(
      (await prisma.backupExecution.findUniqueOrThrow({ where: { id: b.id } }))
        .status
    ).toBe("VERIFICATION_FAILED")
    expect(
      await prisma.operationalIncident.count({
        where: { source: "BACKUP", severity: "CRITICAL" },
      })
    ).toBe(1)
  })

  it("un fallo real de destino queda FAILED con incidencia crítica", async () => {
    configureBackups()
    const blocker = join(storageDir, "no-es-carpeta")
    await writeFile(blocker, "x")
    process.env.BACKUP_STORAGE_DIR = blocker
    const r = await runBackup({ trigger: "MANUAL" })
    expect(r.status).toBe("FAILED")
    const b = await prisma.backupExecution.findFirstOrThrow()
    expect(b.status).toBe("FAILED")
    expect(b.error).toBeTruthy()
    expect(
      await prisma.operationalIncident.count({
        where: { source: "BACKUP", title: "Respaldo automático fallido" },
      })
    ).toBe(1)
  })

  it("prueba de restauración REAL aislada y recuperación protegida REAL en una base nueva (solo SUPERADMIN)", async () => {
    await scenario()
    configureBackups()
    await recreateDatabase("poker_m15_restore_test")
    await recreateDatabase("poker_m15_recovery")
    const backup = await runBackup({ trigger: "MANUAL" })
    expect(backup.status).toBe("SUCCESS")
    const backupId = (backup as { backupId: string }).backupId

    const test = await runRestoreTest({
      backupId,
      trigger: "MANUAL",
      actorId: admin.id,
    })
    expect(test.error).toBeNull()
    expect(test.status).toBe("PASSED")
    const codes = Object.fromEntries(
      (test.checks ?? []).map((c) => [c.code, c.status])
    )
    expect(codes).toMatchObject({
      BACKUP_INTEGRITY: "PASSED",
      SCHEMA_VERSION: "PASSED",
      DATA_FIDELITY: "PASSED",
      DOMAIN_USERS: "PASSED",
      DOMAIN_PURCHASES: "PASSED",
      DOMAIN_DEBTS: "PASSED",
      DOMAIN_AUDIT: "PASSED",
      SUPERADMIN_PRESENT: "PASSED",
      EVIDENCE: "PASSED",
    })
    expect(test.cleanedUp).toBe(true)

    // Recuperación: CASHIER y PARTNER no; SUPERADMIN con contraseña.
    const base = {
      backupId,
      reason: "Pérdida de datos por error operativo grave en producción",
      idempotencyKey: key(),
    }
    await expect(
      requestRecovery(cashier, { ...base, password: TEST_PASSWORD })
    ).rejects.toThrow(/SUPERADMIN/)
    await expect(
      requestRecovery(partner, { ...base, password: TEST_PASSWORD })
    ).rejects.toThrow(/SUPERADMIN/)
    await expect(
      requestRecovery(admin, { ...base, password: "incorrecta" })
    ).rejects.toThrow(/identidad/)
    const { id } = await requestRecovery(admin, {
      ...base,
      password: TEST_PASSWORD,
    })
    let req = await prisma.restoreRequest.findUniqueOrThrow({ where: { id } })
    expect(req.status).toBe("VALIDATED")
    expect(req.validationId).toBe(test.validationId)
    // Aprobar exige mantenimiento activo.
    await expect(
      approveRecovery(admin, id, {
        password: TEST_PASSWORD,
        confirmation: "RECUPERAR",
        expectedVersion: req.version,
      })
    ).rejects.toThrow(/mantenimiento/)
    await setMaintenance(admin, {
      enabled: true,
      reason: "Recuperación de producción en curso",
      password: TEST_PASSWORD,
    })
    // En mantenimiento la API rechaza escrituras de negocio (503).
    signInAs(cashier._user)
    const blocked = await call(incidentsRoute.POST, {
      method: "POST",
      path: "/api/admin/incidents",
      body: {
        title: "Prueba bloqueada",
        description: "No debe registrarse en mantenimiento",
        severity: "LOW",
      },
    })
    expect(blocked.status).toBe(503)
    await approveRecovery(admin, id, {
      password: TEST_PASSWORD,
      confirmation: "RECUPERAR",
      expectedVersion: req.version,
    })
    const before = await money()
    const result = await executeRecovery(id, "operador-pruebas")
    expect(result.passed).toBe(true)
    req = await prisma.restoreRequest.findUniqueOrThrow({ where: { id } })
    expect(req.status).toBe("COMPLETED")
    expect(req.executionReference).toContain("poker_m15_recovery")
    // La base de origen NO se tocó; la nueva tiene los datos del respaldo.
    expect(await money()).toEqual(before)
    const target = new Client({ connectionString: RECOVERY_DB })
    await target.connect()
    const n = await target.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "chip_purchases"`
    )
    await target.end()
    expect(n.rows[0].n).toBe("1")
    // Auditoría fuera del sistema restaurable.
    const external = await readFile(
      join(storageDir, "recovery-audit.jsonl"),
      "utf8"
    )
    expect(external).toMatch(/RECOVERY_REQUESTED/)
    expect(external).toMatch(/RECOVERY_COMPLETED/)
    // Una segunda ejecución es imposible.
    await expect(executeRecovery(id, "operador-pruebas")).rejects.toThrow(
      /APROBADA/
    )
    await setMaintenance(admin, {
      enabled: false,
      reason: "Recuperación verificada, operación normal",
      password: TEST_PASSWORD,
    })
  }, 240_000)
})
