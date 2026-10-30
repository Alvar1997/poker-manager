import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { Client } from "pg"
import { beforeEach, describe, expect, it } from "vitest"

import * as cancelRoute from "@/app/api/sessions/[id]/cancel/route"
import * as previewRoute from "@/app/api/sessions/folio-preview/route"
import * as sessionsRoute from "@/app/api/sessions/route"
import { businessDateOf } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  confirmStockCount,
  initializeStock,
  updateStockCount,
} from "@/modules/inventory/stock-count.service"
import { listSessionReports } from "@/modules/reports/session-report.service"
import { parseReportFilters } from "@/modules/reports/report.filters"
import { planOpeningTable } from "@/modules/sessions/opening-wizard.service"
import {
  confirmOpeningCashCount,
  createOpeningChipCount,
  openSession,
} from "@/modules/sessions/opening.service"
import {
  cancelSession,
  createSession,
  getSession,
  listSessions,
  prepareSession,
} from "@/modules/sessions/session.service"

import {
  auditRows,
  call,
  createUser,
  resetDatabase,
  signInAs,
  signOut,
} from "./helpers"
import { resolveTestDatabaseUrl } from "./test-db"

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
const today = () => businessDateOf(new Date())
let admin: Actor
let cashier: Actor

const historical = (date: string, k = key(), actor: Actor = admin) =>
  createSession(actor, {
    idempotencyKey: k,
    historical: true,
    businessDate: date,
    openingTime: "20:00",
  })

/** Crea una sesión de fecha anterior y la cancela para liberar la vigente. */
async function historicalDone(date: string) {
  const s = await historical(date)
  await cancelSession(admin, s.id, { reason: "Prueba de consecutivo" })
  return s
}

/** Registro HISTORICAL anterior al cambio (solo folio y fecha). */
async function legacyHistorical(date: string) {
  const cashBox = await prisma.cashBox.findUniqueOrThrow({
    where: { code: "MAIN" },
  })
  const n = (await prisma.pokerSession.count()) + 1
  const id = await prisma.$transaction(async (tx) => {
    // Simula una fila creada antes de la migración 20261107120000.
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
    const created = await tx.pokerSession.create({
      data: {
        folio: `S-${String(n).padStart(4, "0")}-${date.replaceAll("-", "")}`,
        sequenceNumber: n,
        businessDate: new Date(`${date}T00:00:00.000Z`),
        status: "HISTORICAL",
        cashBoxId: cashBox.id,
        createdById: admin.id,
        idempotencyKey: key(),
        isHistorical: true,
        historicalRecordedAt: new Date(),
        historicalRecordedById: admin.id,
      },
      select: { id: true },
    })
    await tx.$executeRaw`UPDATE "folio_sequences" SET "nextNumber" = GREATEST("nextNumber", ${n + 1}) WHERE "documentType" = 'SESSION'`
    return created.id
  })
  return getSession(id)
}

async function moneyAndChips() {
  const state = await prisma.chipSetInventoryState.findFirst()
  return {
    cashTx: await prisma.cashTransaction.count(),
    balances: await prisma.financialAccountBalance.count(),
    reconciliations: await prisma.cashReconciliation.count(),
    chipOps: await prisma.chipInventoryOperation.count(),
    nominalMoves: await prisma.chipNominalMovement.count(),
    custody: state?.custodyNominal.toFixed(2) ?? null,
    circulation: state?.circulationNominal.toFixed(2) ?? null,
    counts: await prisma.chipStockCount.count(),
  }
}

beforeEach(async () => {
  await resetDatabase()
  signOut()
  admin = await actorFor("SUPERADMIN")
  cashier = await actorFor("CASHIER")
})

describe("folio S-0001-YYYYMMDD y fecha operativa", () => {
  it("una sesión normal recibe consecutivo global, fecha operativa de hoy y folio del servidor", async () => {
    const s = await createSession(cashier, { idempotencyKey: key() })
    const date = today()
    expect(s).toMatchObject({
      status: "DRAFT",
      sequenceNumber: 1,
      businessDate: date,
      isHistorical: false,
      historicalRecordedAt: null,
      previousFolio: null,
      folio: `S-0001-${date.replaceAll("-", "")}`,
    })
    const audits = await auditRows("SESSION_FOLIO_ASSIGNED")
    expect(audits).toHaveLength(1)
    expect(audits[0].metadata).toMatchObject({
      folio: s.folio,
      sequenceNumber: 1,
      businessDate: date,
      kind: "REGULAR",
    })
    expect(audits[0].sessionId).toBe(s.id)
  })

  it("el folio, el consecutivo y la fecha operativa son inmutables (la base lo impide)", async () => {
    const s = await createSession(cashier, { idempotencyKey: key() })
    await expect(
      prisma.pokerSession.update({
        where: { id: s.id },
        data: { folio: "S-0099-20260101" },
      })
    ).rejects.toThrow(/inmutables/)
    await expect(
      prisma.pokerSession.update({
        where: { id: s.id },
        data: { businessDate: new Date("2026-01-01T00:00:00Z") },
      })
    ).rejects.toThrow(/inmutables/)
    // Cambiar de estado no regenera el folio.
    await prepareSession(cashier, s.id)
    expect((await getSession(s.id)).folio).toBe(s.folio)
  })

  it("la base exige que el folio coincida con consecutivo y fecha operativa", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "poker_sessions" ("id","folio","sequenceNumber","businessDate","cashBoxId","createdById","idempotencyKey","updatedAt")
         SELECT 'x1','S-0007-20261014',8,'2026-10-14',"id",'${cashier.id}','kx',now() FROM "cash_boxes" LIMIT 1`
      )
    ).rejects.toThrow(/poker_sessions_folio_format/)
  })
})

describe("sesión de fecha anterior (solo SUPERADMIN)", () => {
  it("se crea en DRAFT con la fecha del 14/10/2026, sin mover caja ni inventario al crearla", async () => {
    const before = await moneyAndChips()
    const t0 = Date.now()
    const h = await historical("2026-10-14")
    expect(h).toMatchObject({
      status: "DRAFT",
      isHistorical: true,
      businessDate: "2026-10-14",
      openedAt: null,
      closedAt: null,
      historicalRecordedBy: { id: admin.id },
      // 14/10/2026 20:00 en Monterrey (UTC−6).
      operatedOpenedAt: "2026-10-15T02:00:00.000Z",
    })
    expect(h.folio).toMatch(/^S-\d{4}-20261014$/)
    expect(new Date(h.historicalRecordedAt!).getTime()).toBeGreaterThanOrEqual(
      t0 - 5
    )
    expect(await moneyAndChips()).toEqual(before)
    const audit = await auditRows("HISTORICAL_SESSION_CREATED")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorUserId: admin.id,
      actorRole: "SUPERADMIN",
      sessionId: h.id,
    })
    expect(audit[0].metadata).toMatchObject({
      folio: h.folio,
      businessDate: "2026-10-14",
      kind: "HISTORICAL",
    })
  })

  it("se opera completa: conteo, caja $0, apertura con mesa y la fecha operativa se conserva", async () => {
    const shared = await prisma.chipSet.findUniqueOrThrow({
      where: { code: "CHIPSET_MAIN" },
    })
    const d = await prisma.chipDenomination.create({
      data: { chipSetId: shared.id, value: "100" },
    })
    await initializeStock(admin, {
      chipSetId: shared.id,
      lines: [{ denominationId: d.id, quantity: 50 }],
      idempotencyKey: key(),
    })
    const h = await historical("2026-10-21")
    await prepareSession(admin, h.id)
    const { count } = await createOpeningChipCount(admin, h.id)
    await updateStockCount(admin, count.id, {
      lines: count.details.map((x) => ({
        denominationId: x.denominationId,
        countedQuantity: x.expectedQuantity,
      })),
    })
    await confirmStockCount(admin, count.id, key())
    await confirmOpeningCashCount(admin, h.id, {
      countedAmount: "0",
      physicallyVerified: true,
    })
    const t25 = await prisma.pokerTable.findUniqueOrThrow({
      where: { code: "TABLE_25_25" },
    })
    await planOpeningTable(admin, h.id, t25.id)
    await openSession(admin, h.id, { idempotencyKey: key() })
    const opened = await getSession(h.id)
    expect(opened).toMatchObject({
      status: "OPEN",
      isHistorical: true,
      businessDate: "2026-10-21",
      folio: h.folio,
    })
    const tables = await prisma.sessionTable.findMany({
      where: { sessionId: h.id },
      select: { tableId: true, status: true },
    })
    expect(tables).toEqual([{ tableId: t25.id, status: "OPEN" }])
    // Ocupa la sesión vigente: no se crea otra hasta cerrarla.
    await expect(
      createSession(cashier, { idempotencyKey: key() })
    ).rejects.toThrow(/sesión vigente/)
  })

  it("ocupa la sesión vigente: con una sesión en curso no se crea (409)", async () => {
    await createSession(cashier, { idempotencyKey: key() })
    await expect(historical("2026-10-14")).rejects.toThrow(/sesión vigente/)
    expect(await prisma.pokerSession.count()).toBe(1)
  })

  it("consecutivo global por orden de captura: misma fecha distinto número; una fecha anterior no renumera", async () => {
    const a = await historicalDone("2026-10-14")
    const b = await historicalDone("2026-10-14")
    const c = await historicalDone("2026-10-17")
    const d = await historicalDone("2026-10-10")
    expect([a, b, c, d].map((s) => s.sequenceNumber)).toEqual([1, 2, 3, 4])
    expect([a, b, c, d].map((s) => s.folio)).toEqual([
      "S-0001-20261014",
      "S-0002-20261014",
      "S-0003-20261017",
      "S-0004-20261010",
    ])
    expect((await getSession(a.id)).folio).toBe("S-0001-20261014")
  })

  it("creaciones simultáneas: solo una queda vigente y el consecutivo no se salta", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => historical("2026-09-01"))
    )
    const ok = results.filter((r) => r.status === "fulfilled")
    expect(ok).toHaveLength(1)
    expect(await prisma.pokerSession.count()).toBe(1)
    const next = await createSession(cashier, { idempotencyKey: key() }).catch(
      () => null
    )
    expect(next).toBeNull()
    const [only] = await prisma.pokerSession.findMany()
    expect(only.sequenceNumber).toBe(1)
  })

  it("idempotencia: el mismo intento no duplica; la misma clave con otra fecha → 409", async () => {
    const k = key()
    const first = await historical("2026-10-14", k)
    const again = await historical("2026-10-14", k)
    expect(again).toMatchObject({ id: first.id, replayed: true })
    expect(await prisma.pokerSession.count()).toBe(1)
    await expect(historical("2026-10-13", k)).rejects.toThrow(
      /ya se usó para otra sesión/
    )
  })

  it("rechaza hoy y fechas futuras (y lo audita)", async () => {
    await expect(historical(today())).rejects.toThrow(/flujo normal/)
    await expect(historical("2999-01-01")).rejects.toThrow(/futuras/)
    expect(await prisma.pokerSession.count()).toBe(0)
    expect(
      await auditRows("HISTORICAL_SESSION_CREATION_REJECTED")
    ).toHaveLength(2)
  })

  it("PARTNER y CASHIER no pueden (ni manipulando la petición): 403 auditado", async () => {
    for (const role of ["PARTNER", "CASHIER"] as const) {
      const u = await actorFor(role)
      signInAs(u._user)
      const res = await call(sessionsRoute.POST, {
        method: "POST",
        body: {
          idempotencyKey: key(),
          historical: true,
          businessDate: "2026-10-14",
          openingTime: "20:00",
        },
      })
      expect(res.status, role).toBe(403)
      // Una fecha sin el modo histórico tampoco se acepta.
      const sneaky = await call(sessionsRoute.POST, {
        method: "POST",
        body: { idempotencyKey: key(), businessDate: "2026-10-14" },
      })
      expect(sneaky.status, role).toBe(400)
    }
    expect(await prisma.pokerSession.count()).toBe(0)
    const rejected = await auditRows("HISTORICAL_SESSION_CREATION_REJECTED")
    expect(rejected.map((r) => [r.actorRole, r.result])).toEqual([
      ["PARTNER", "DENIED"],
      ["CASHIER", "DENIED"],
    ])
    signInAs(admin._user)
    const ok = await call(sessionsRoute.POST, {
      method: "POST",
      body: {
        idempotencyKey: key(),
        historical: true,
        businessDate: "2026-10-14",
        openingTime: "20:00",
      },
    })
    expect(ok.status).toBe(201)
  })

  it("la base ya no admite crear sesiones en estado HISTORICAL", async () => {
    await expect(
      prisma.pokerSession.create({
        data: {
          folio: "S-0001-20261014",
          sequenceNumber: 1,
          businessDate: new Date("2026-10-14T00:00:00.000Z"),
          status: "HISTORICAL",
          cashBoxId: (
            await prisma.cashBox.findUniqueOrThrow({
              where: { code: "MAIN" },
            })
          ).id,
          createdById: admin.id,
          idempotencyKey: key(),
          isHistorical: true,
          historicalRecordedAt: new Date(),
          historicalRecordedById: admin.id,
        },
      })
    ).rejects.toThrow(/se crea en DRAFT/)
  })

  it("un registro HISTORICAL anterior no se prepara ni se abre; solo SUPERADMIN lo cancela", async () => {
    const h = await legacyHistorical("2026-10-14")
    await expect(prepareSession(admin, h.id)).rejects.toThrow()
    await expect(
      prisma.pokerSession.update({
        where: { id: h.id },
        data: { status: "OPEN", openedAt: new Date(), openedById: admin.id },
      })
    ).rejects.toThrow(/Transición de sesión no permitida/)
    await expect(
      cancelSession(cashier, h.id, { reason: "Registrada por error" })
    ).rejects.toThrow(/superadministrador/)
    signInAs(cashier._user)
    expect(
      (
        await call(cancelRoute.POST, {
          method: "POST",
          params: { id: h.id },
          body: { reason: "Registrada por error" },
        })
      ).status
    ).toBe(403)
    await cancelSession(admin, h.id, { reason: "Registrada por error" })
    const c = await getSession(h.id)
    expect(c).toMatchObject({ status: "CANCELLED", folio: h.folio })
    // Un registro anterior no ocupa la sesión vigente.
    const s = await createSession(cashier, { idempotencyKey: key() })
    expect(s.status).toBe("DRAFT")
  })

  it("vista previa provisional del folio sin consumir el consecutivo", async () => {
    signInAs(admin._user)
    const res = await call(previewRoute.GET, {
      path: "/api/sessions/folio-preview?businessDate=2026-10-14",
    })
    expect(res.json.data).toMatchObject({
      provisional: true,
      folio: "S-0001-20261014",
    })
    const again = await call(previewRoute.GET, {
      path: "/api/sessions/folio-preview?businessDate=2026-10-14",
    })
    expect((again.json.data as { folio: string }).folio).toBe("S-0001-20261014")
    expect((await historical("2026-10-14")).folio).toBe("S-0001-20261014")
  })
})

describe("listados y reportes por fecha operativa", () => {
  it("filtran por businessDate (no por la fecha de captura) y buscan por folio", async () => {
    const a = await historicalDone("2026-10-14")
    await historicalDone("2026-10-17")
    const normal = await createSession(cashier, { idempotencyKey: key() })
    const list = await listSessions({
      from: "2026-10-14",
      to: "2026-10-14",
      sort: "desc",
      page: 1,
      pageSize: 20,
    })
    expect(list.items.map((s) => s.id)).toEqual([a.id])
    const historicals = await listSessions({
      kind: "historical",
      sort: "asc",
      page: 1,
      pageSize: 20,
    })
    expect(historicals.items.map((s) => s.businessDate)).toEqual([
      "2026-10-14",
      "2026-10-17",
    ])
    const byFolio = await listSessions({
      q: normal.folio.toLowerCase(),
      sort: "desc",
      page: 1,
      pageSize: 20,
    })
    expect(byFolio.items.map((s) => s.id)).toEqual([normal.id])

    const parsed = parseReportFilters("sessions", {
      from: "2026-10-14",
      to: "2026-10-17",
    })
    if (!parsed.ok) throw new Error("filtros inválidos")
    const report = await listSessionReports(parsed.filters)
    expect(
      report.items.map((r) => [r.folio, r.operatedDay, r.isHistorical])
    ).toEqual([
      [expect.stringMatching(/-20261017$/), "2026-10-17", true],
      [a.folio, "2026-10-14", true],
    ])
  })
})

describe("migración de folios anteriores", () => {
  it("convierte SES-000001 de forma determinista, conserva el anterior, audita la equivalencia y es idempotente", async () => {
    const base = new URL(resolveTestDatabaseUrl())
    const dbName = `poker_migration_${Date.now()}`
    const admin = new Client({ connectionString: base.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    const url = new URL(base.toString())
    url.pathname = `/${dbName}`
    const db = new Client({ connectionString: url.toString() })
    await db.connect()
    try {
      const dir = path.join(process.cwd(), "prisma", "migrations")
      const all = readdirSync(dir)
        .filter((d) => /^\d{14}_/.test(d))
        .sort()
      const NEW = [
        "20261031120000_session_folio_enums",
        "20261031130000_session_folio_historical",
        // Depende de las columnas de captura de la anterior.
        "20261107120000_backdated_sessions",
      ]
      for (const m of all.filter((d) => !NEW.includes(d)))
        await db.query(readFileSync(path.join(dir, m, "migration.sql"), "utf8"))
      await db.query(`
        INSERT INTO users (id,name,email,"passwordHash",role,"updatedAt") VALUES ('u1','Admin','a@x.mx','x','SUPERADMIN',now());
        INSERT INTO cash_boxes (id,code,name,"updatedAt") VALUES ('cb1','MAIN','Caja',now());
        INSERT INTO folio_sequences (id,"documentType",prefix,"nextNumber",padding,"updatedAt") VALUES ('f1','SESSION','SES',6,6,now());
        ALTER TABLE poker_sessions DISABLE TRIGGER poker_sessions_insert_guard;
        INSERT INTO poker_sessions (id,folio,"cashBoxId",status,"createdById","idempotencyKey","createdAt","updatedAt","cancelledAt","cancellationReason") VALUES
          ('s1','SES-000001','cb1','CANCELLED','u1','k1','2026-10-14T03:30:00Z',now(),now(),'prueba'),
          ('s2','SES-000005','cb1','CANCELLED','u1','k2','2026-10-17T20:00:00Z',now(),now(),'prueba'),
          ('s3','RARO-ABC','cb1','CANCELLED','u1','k3','2026-10-20T20:00:00Z',now(),now(),'prueba');
        ALTER TABLE poker_sessions ENABLE TRIGGER poker_sessions_insert_guard;
      `)
      const run = async () => {
        for (const m of NEW)
          await db.query(
            readFileSync(path.join(dir, m, "migration.sql"), "utf8")
          )
      }
      const snapshot = async () =>
        (
          await db.query(
            `SELECT id, folio, "previousFolio", "sequenceNumber", to_char("businessDate",'YYYY-MM-DD') d FROM poker_sessions ORDER BY id`
          )
        ).rows
      await run()
      const first = await snapshot()
      expect(first).toEqual([
        // 21:30 del 13 oct en Monterrey (03:30 UTC del 14).
        {
          id: "s1",
          folio: "S-0001-20261013",
          previousFolio: "SES-000001",
          sequenceNumber: 1,
          d: "2026-10-13",
        },
        // El hueco 2–4 se conserva (no se renumera).
        {
          id: "s2",
          folio: "S-0005-20261017",
          previousFolio: "SES-000005",
          sequenceNumber: 5,
          d: "2026-10-17",
        },
        // Formato irreconocible: después del mayor, por orden de creación.
        {
          id: "s3",
          folio: "S-0006-20261020",
          previousFolio: "RARO-ABC",
          sequenceNumber: 6,
          d: "2026-10-20",
        },
      ])
      const seq = await db.query(
        `SELECT prefix, padding, "nextNumber" FROM folio_sequences WHERE "documentType"='SESSION'`
      )
      expect(seq.rows[0]).toEqual({ prefix: "S", padding: 4, nextNumber: 7 })
      // Re-ejecutarla no cambia nada ni duplica la auditoría.
      await run()
      expect(await snapshot()).toEqual(first)
      const audit = await db.query(
        `SELECT "entityId", metadata->>'previousFolio' p, metadata->>'folio' f FROM audit_logs WHERE action='SESSION_FOLIO_MIGRATED' ORDER BY 1`
      )
      expect(audit.rows).toEqual([
        { entityId: "s1", p: "SES-000001", f: "S-0001-20261013" },
        { entityId: "s2", p: "SES-000005", f: "S-0005-20261017" },
        { entityId: "s3", p: "RARO-ABC", f: "S-0006-20261020" },
      ])
    } finally {
      await db.end()
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`)
      await admin.end()
    }
  }, 120_000)
})
