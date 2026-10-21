// @vitest-environment node
import { createGunzip, createGzip } from "node:zlib"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createWriteStream } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  deriveAuditColumns,
  maskValue,
  moduleOfAction,
} from "@/modules/audit/audit-taxonomy"
import { sanitizeMetadata } from "@/modules/audit/audit.service"
import { parseAuditFilters } from "@/modules/audit/audit.filters"
import {
  canTransition,
  CORRECTION_TYPE_META,
  displayStatus,
  isAuthorizerRole,
  selfApprovalBlocked,
} from "@/modules/corrections/correction.rules"
import { createCorrectionSchema } from "@/modules/corrections/correction.schemas"
import {
  fingerprintOf,
  safeRun,
  shouldOpenIncident,
  summarize,
  type CheckResult,
} from "@/modules/integrity/integrity.math"
import {
  getBackupConfig,
  keyFingerprintOf,
  parseKey,
  sameDatabase,
} from "@/modules/backups/backup.config"
import { decryptFile, encryptStream } from "@/modules/backups/backup.crypto"
import {
  compareTables,
  digestSnapshot,
  evidenceProblems,
  parseLine,
} from "@/modules/backups/backup.snapshot"
import { retentionPlan } from "@/modules/backups/backup.policy"
import { FilesystemBackupStorage } from "@/modules/backups/backup.storage"
import { assertSafeTarget } from "@/modules/backups/restore.service"
import { incidentTransitionAllowed } from "@/modules/incidents/incident.service"
import { updateIncidentSchema } from "@/modules/admin/admin.schemas"

const KEY = Buffer.alloc(32, 7)

describe("auditoría transversal", () => {
  it("deriva el módulo de cada acción", () => {
    expect(moduleOfAction("AUTH_LOGIN_FAILED")).toBe("SECURITY")
    expect(moduleOfAction("USER_ROLE_CHANGED")).toBe("USERS")
    expect(moduleOfAction("CHIP_DENOMINATION_CREATED")).toBe("CONFIGURATION")
    expect(moduleOfAction("PURCHASE_CONFIRMED")).toBe("PURCHASES")
    expect(moduleOfAction("PAYMENT_ALLOCATED")).toBe("CREDITS")
    expect(moduleOfAction("SETTLEMENT_PAYOUT_CONFIRMED")).toBe("SETTLEMENTS")
    expect(moduleOfAction("SESSION_CLOSED")).toBe("CLOSURE")
    expect(moduleOfAction("SESSION_OPENED")).toBe("SESSIONS")
    expect(moduleOfAction("TABLE_PLAYER_ADDED")).toBe("TABLES")
    expect(moduleOfAction("CASH_CONTRIBUTION_REGISTERED")).toBe("CASH")
    expect(moduleOfAction("REPORT_EXPORTED")).toBe("REPORTS")
    expect(moduleOfAction("BACKUP_COMPLETED")).toBe("INFRASTRUCTURE")
    expect(moduleOfAction("CORRECTION_APPROVED")).toBe("ADMINISTRATION")
  })

  it("asocia sesión, compra/jugador, ciclo e importe desde los metadatos", () => {
    const d = deriveAuditColumns("PURCHASE_CONFIRMED", {
      sessionId: "s1",
      playerId: "p1",
      cycleId: "c1",
      nominalAmount: "3000.00",
      idempotencyKey: "k-1",
    })
    expect(d).toMatchObject({
      module: "PURCHASES",
      sessionId: "s1",
      playerId: "p1",
      tableCycleId: "c1",
      amount: "3000.00",
      idempotencyKey: "k-1",
    })
    expect(deriveAuditColumns("X", { amount: 12 }).amount).toBeNull()
  })

  it("nunca guarda secretos y enmascara datos bancarios", () => {
    const s = sanitizeMetadata({
      password: "x",
      passwordHash: "y",
      token: "t",
      authorization: "Bearer",
      clabe: "012345678901234567",
      nested: { secretKey: "k", ok: 1 },
    }) as Record<string, unknown>
    expect(s).not.toHaveProperty("password")
    expect(s).not.toHaveProperty("passwordHash")
    expect(s).not.toHaveProperty("token")
    expect(s).not.toHaveProperty("authorization")
    expect(s.clabe).toBe("••••4567")
    expect(s.nested).toEqual({ ok: 1 })
    expect(maskValue("cardNumber", "4111 1111 1111 1234")).toBe("••••1234")
  })

  it("valida filtros de auditoría en servidor", () => {
    expect(parseAuditFilters({ module: "CASH", page: "2" }).ok).toBe(true)
    expect(parseAuditFilters({ module: "NOPE" }).ok).toBe(false)
    expect(parseAuditFilters({ from: "2026-10-20", to: "2026-10-01" }).ok).toBe(
      false
    )
    expect(parseAuditFilters({ operationId: "x'; DELETE" }).ok).toBe(false)
  })
})

describe("correcciones excepcionales", () => {
  it("aprobar no equivale a ejecutar; los procesos del Módulo 16 se ejecutan en Operaciones especiales", () => {
    for (const t of [
      "PURCHASE_REVERSAL",
      "SETTLEMENT_REVERSAL_WITH_PAYOUTS",
      "UNAPPLIED_FUNDS_RETURN",
      "LATE_CHIP_REDEMPTION",
    ] as const) {
      expect(CORRECTION_TYPE_META[t].module16).toBe(true)
      expect(CORRECTION_TYPE_META[t].execution?.service).toMatch(
        /Operaciones especiales/
      )
      expect(displayStatus("APPROVED", t)).toMatch(
        /pendiente de ejecución.*Módulo 16/
      )
    }
    expect(displayStatus("APPROVED", "RECEIVABLE_PAYMENT_REVERSAL")).toMatch(
      /pendiente de ejecutar/
    )
    expect(displayStatus("EXECUTED", "RECEIVABLE_PAYMENT_REVERSAL")).toBe(
      "Ejecutada"
    )
  })

  it("transiciones válidas y terminales", () => {
    expect(canTransition("REQUESTED", "APPROVED")).toBe(true)
    expect(canTransition("APPROVED", "EXECUTED")).toBe(true)
    expect(canTransition("REQUESTED", "EXECUTED")).toBe(false)
    expect(canTransition("REJECTED", "APPROVED")).toBe(false)
    expect(canTransition("EXECUTED", "CANCELLED")).toBe(false)
  })

  it("autorizadores: PARTNER y SUPERADMIN; CASHIER no", () => {
    expect(isAuthorizerRole("PARTNER")).toBe(true)
    expect(isAuthorizerRole("SUPERADMIN")).toBe(true)
    expect(isAuthorizerRole("CASHIER")).toBe(false)
  })

  it("evita la autoaprobación si hay otro autorizador", () => {
    expect(
      selfApprovalBlocked({
        actorId: "a",
        requestedById: "a",
        otherActiveAuthorizers: 1,
      })
    ).toBe(true)
    expect(
      selfApprovalBlocked({
        actorId: "a",
        requestedById: "a",
        otherActiveAuthorizers: 0,
      })
    ).toBe(false)
    expect(
      selfApprovalBlocked({
        actorId: "a",
        requestedById: "b",
        otherActiveAuthorizers: 3,
      })
    ).toBe(false)
  })

  it("la solicitud exige motivo y rechaza campos extra (p. ej. status)", () => {
    const base = {
      type: "PURCHASE_REVERSAL",
      targetType: "ChipPurchase",
      targetId: "p1",
      reason: "Compra duplicada por error",
      idempotencyKey: "abcd1234",
    }
    expect(createCorrectionSchema.safeParse(base).success).toBe(true)
    expect(
      createCorrectionSchema.safeParse({ ...base, reason: "corto" }).success
    ).toBe(false)
    expect(
      createCorrectionSchema.safeParse({ ...base, status: "EXECUTED" }).success
    ).toBe(false)
  })
})

describe("motor de integridad", () => {
  it("una comprobación que falla técnicamente es NOT_EVALUATED (nunca OK)", async () => {
    const r = await safeRun({
      code: "X",
      category: "CASH",
      title: "t",
      run: async () => {
        throw new Error("boom")
      },
    })
    expect(r[0].status).toBe("NOT_EVALUATED")
    const ok = await safeRun({
      code: "Y",
      category: "CASH",
      title: "t",
      run: async () => [],
    })
    expect(ok[0].status).toBe("OK")
  })

  it("resume por comprobación y prioriza ERROR", () => {
    const res: CheckResult[] = [
      {
        checkCode: "A",
        category: "CASH",
        status: "OK",
        severity: "INFO",
        explanation: "",
      },
      {
        checkCode: "B",
        category: "CASH",
        status: "ERROR",
        severity: "CRITICAL",
        explanation: "",
      },
      {
        checkCode: "B",
        category: "CASH",
        status: "ERROR",
        severity: "CRITICAL",
        explanation: "",
      },
      {
        checkCode: "C",
        category: "CASH",
        status: "WARNING",
        severity: "LOW",
        explanation: "",
      },
    ]
    const s = summarize(res)
    expect(s).toMatchObject({
      checks: 3,
      ok: 1,
      error: 1,
      warning: 1,
      overall: "ERROR",
      critical: 2,
    })
  })

  it("deudas pendientes y fichas en circulación no abren incidencias", () => {
    expect(
      shouldOpenIncident({
        checkCode: "RECEIVABLES_PENDING_INFO",
        category: "DEBTS",
        status: "OK",
        severity: "INFO",
        explanation: "",
      })
    ).toBe(false)
    expect(
      shouldOpenIncident({
        checkCode: "INV_CIRCULATION_INFO",
        category: "INVENTORY",
        status: "OK",
        severity: "INFO",
        explanation: "",
      })
    ).toBe(false)
    expect(
      shouldOpenIncident({
        checkCode: "PAYOUT_NOT_EXCEED",
        category: "SETTLEMENTS",
        status: "ERROR",
        severity: "CRITICAL",
        explanation: "",
      })
    ).toBe(true)
    expect(
      shouldOpenIncident({
        checkCode: "W",
        category: "DEBTS",
        status: "WARNING",
        severity: "MEDIUM",
        explanation: "",
      })
    ).toBe(false)
  })

  it("la huella identifica el mismo hallazgo (dedupe de incidencias)", () => {
    expect(
      fingerprintOf({ checkCode: "A", entityType: "X", entityId: "1" })
    ).toBe(fingerprintOf({ checkCode: "A", entityType: "X", entityId: "1" }))
    expect(fingerprintOf({ checkCode: "A", entityId: "1" })).not.toBe(
      fingerprintOf({ checkCode: "A", entityId: "2" })
    )
  })
})

describe("incidencias", () => {
  it("transiciones y resolución explícita", () => {
    expect(incidentTransitionAllowed("OPEN", "RESOLVED")).toBe(true)
    expect(incidentTransitionAllowed("RESOLVED", "OPEN")).toBe(true)
    expect(incidentTransitionAllowed("RESOLVED", "DISMISSED")).toBe(false)
    expect(
      updateIncidentSchema.safeParse({ expectedVersion: 1, status: "DELETED" })
        .success
    ).toBe(false)
  })
})

describe("respaldos: configuración y protección de credenciales", () => {
  it("sin variables queda NOT_CONFIGURED con nombres (nunca valores)", () => {
    const c = getBackupConfig({ DIRECT_URL: "postgresql://u:secret@h/db" })
    expect(c.configured).toBe(false)
    expect(c.missing).toEqual(["BACKUP_STORAGE_DIR", "BACKUP_ENCRYPTION_KEY"])
    expect(JSON.stringify(c.missing)).not.toMatch(/secret/)
  })

  it("clave válida: base64 o hex de 32 bytes; la huella no revela la clave", () => {
    const b64 = KEY.toString("base64")
    expect(parseKey(b64)?.equals(KEY)).toBe(true)
    expect(parseKey(KEY.toString("hex"))?.equals(KEY)).toBe(true)
    expect(parseKey("corta")).toBeNull()
    const c = getBackupConfig({
      BACKUP_STORAGE_DIR: "/tmp/x",
      BACKUP_ENCRYPTION_KEY: b64,
      DIRECT_URL: "postgresql://h/db",
    })
    expect(c.configured).toBe(true)
    expect(c.keyFingerprint).toBe(keyFingerprintOf(KEY))
    expect(c.keyFingerprint).not.toContain(b64.slice(0, 8))
  })

  it("rechaza reutilizar la clave de configuración", () => {
    const k = KEY.toString("base64")
    const c = getBackupConfig({
      BACKUP_STORAGE_DIR: "/x",
      BACKUP_ENCRYPTION_KEY: k,
      SETTINGS_ENCRYPTION_KEY: k,
      DIRECT_URL: "postgresql://h/db",
    })
    expect(c.configured).toBe(false)
  })

  it("identifica la misma base aunque use el pooler de Neon", () => {
    expect(
      sameDatabase(
        "postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb",
        "postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb"
      )
    ).toBe(true)
    expect(
      sameDatabase(
        "postgresql://u:p@localhost:5432/a",
        "postgresql://u:p@localhost:5432/b"
      )
    ).toBe(false)
  })
})

describe("recuperación protegida: el destino nunca es producción", () => {
  const config = getBackupConfig({
    BACKUP_STORAGE_DIR: "/x",
    BACKUP_ENCRYPTION_KEY: KEY.toString("base64"),
    DIRECT_URL: "postgresql://u:p@ep-x.neon.tech/neondb",
  })
  it("rechaza la base de origen", () => {
    expect(() =>
      assertSafeTarget(
        "postgresql://u:p@ep-x-pooler.neon.tech/neondb",
        config,
        { DATABASE_URL: "postgresql://u:p@ep-x-pooler.neon.tech/neondb" }
      )
    ).toThrow(/nunca la sobrescribe/)
  })
  it("exige un nombre declarado como aislado", () => {
    expect(() =>
      assertSafeTarget("postgresql://u:p@localhost/otra", config, {})
    ).toThrow(/aislada/)
    expect(
      assertSafeTarget(
        "postgresql://u:p@localhost/poker_restore_test",
        config,
        {}
      ).database
    ).toBe("poker_restore_test")
    expect(() =>
      assertSafeTarget(
        "postgresql://u:p@localhost/poker_restore_test",
        config,
        {},
        "recovery"
      )
    ).toThrow(/recovery/)
  })
})

describe("respaldos: cifrado, formato, verificación y retención", () => {
  it("cifra y descifra; una alteración se detecta (no se entregan datos manipulados)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pmbk-"))
    const file = join(dir, "a.pmbk")
    await pipeline(
      Readable.from([Buffer.from("H\t{}\nE\t{}\n")]),
      createGzip(),
      encryptStream(KEY),
      createWriteStream(file)
    )
    const chunks: Buffer[] = []
    for await (const c of await decryptFile(file, KEY, [createGunzip()]))
      chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe("H\t{}\nE\t{}\n")
    const bytes = await readFile(file)
    bytes[bytes.length - 20] ^= 0xff
    await writeFile(file, bytes)
    await expect(
      (async () => {
        for await (const _ of await decryptFile(file, KEY, [createGunzip()]))
          void _
      })()
    ).rejects.toThrow()
    await expect(
      (async () => {
        for await (const _ of await decryptFile(file, Buffer.alloc(32, 1)))
          void _
      })()
    ).rejects.toThrow()
  })

  it("parsea líneas y recalcula huellas por tabla", async () => {
    expect(parseLine('R\tusers\t{"id":"1","n":1500.00}')).toEqual({
      kind: "R",
      table: "users",
      json: '{"id":"1","n":1500.00}',
    })
    const text =
      [
        'H\t{"format":"x","recoveryPoint":"t","serverVersion":"18","schemaVersion":"m","migrations":["m"]}',
        'T\tusers\t{"columns":["id"]}',
        'R\tusers\t{"id":"1"}',
        'E\t{"tables":1,"rows":1}',
      ].join("\n") + "\n"
    const d = await digestSnapshot(Readable.from([Buffer.from(text)]))
    expect(d.tables.users.rows).toBe(1)
    expect(compareTables(d.tables, d.tables)).toEqual([])
    expect(
      compareTables(d.tables, { users: { rows: 2, sha256: "x" } })
    ).toHaveLength(1)
  })

  it("detecta evidencias activas faltantes o alteradas", () => {
    const base = {
      storageKey: "k",
      purpose: "PURCHASE_SIGNATURE",
      sizeBytes: 1,
      purchaseId: null,
      settlementId: null,
      signatureId: "s",
    }
    expect(
      evidenceProblems([
        {
          ...base,
          fileId: "ok",
          status: "ACTIVE",
          sha256: "a",
          actualSha256: "a",
        },
        {
          ...base,
          fileId: "gone",
          status: "ACTIVE",
          sha256: "a",
          actualSha256: null,
        },
        {
          ...base,
          fileId: "bad",
          status: "ACTIVE",
          sha256: "a",
          actualSha256: "b",
        },
        {
          ...base,
          fileId: "pending",
          status: "PENDING",
          sha256: "a",
          actualSha256: null,
        },
      ])
    ).toEqual([
      { fileId: "gone", problem: "missing" },
      { fileId: "bad", problem: "hash-mismatch" },
    ])
  })

  it("retención: 30 días diarios + primero de cada mes 6 meses; nunca el último exitoso", () => {
    const now = new Date("2026-10-21T12:00:00Z")
    const day = (n: number) => new Date(now.getTime() - n * 86_400_000)
    const plan = retentionPlan(
      [
        { id: "today", at: day(0), ok: true },
        { id: "d20", at: day(20), ok: true },
        { id: "d40", at: day(40), ok: true },
        { id: "d41", at: day(41), ok: true },
        { id: "d400", at: day(400), ok: true },
        { id: "fail45", at: day(45), ok: false },
      ],
      { dailyDays: 30, monthlyMonths: 6, now }
    )
    expect(plan.keep).toEqual(expect.arrayContaining(["today", "d20", "d41"]))
    expect(plan.prune).toEqual(
      expect.arrayContaining(["d40", "d400", "fail45"])
    )
    expect(
      retentionPlan([{ id: "only", at: day(900), ok: true }], {
        dailyDays: 1,
        monthlyMonths: 0,
        now,
      }).keep
    ).toEqual(["only"])
  })

  it("el destino nunca sobrescribe un artefacto y calcula su checksum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pmst-"))
    const st = new FilesystemBackupStorage(dir)
    const a = await st.put(
      "2026/10/x.pmbk",
      Readable.from([Buffer.from("abc")])
    )
    expect(a.sizeBytes).toBe(3)
    expect((await st.sha256("2026/10/x.pmbk")).sha256).toBe(a.sha256)
    await expect(
      st.put("2026/10/x.pmbk", Readable.from([Buffer.from("zzz")]))
    ).rejects.toThrow()
    expect(await readFile(join(dir, "2026/10/x.pmbk"), "utf8")).toBe("abc")
    expect(() => st.pathOf("../../etc/passwd")).toThrow()
  })
})
