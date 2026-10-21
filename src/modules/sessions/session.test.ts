import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { OPERATIONAL_RULES } from "@/config/operational-rules"
import { Prisma } from "@/generated/prisma/client"
import { businessDateOf, formatDateTime } from "@/lib/format"
import {
  nominalAvailable,
  parseNominalAmount,
} from "@/modules/inventory/inventory.math"
import {
  addPlayerSchema,
  closeTableSchema,
  historyQuerySchema,
  openTableSchema,
  transferSchema,
} from "@/modules/session-tables/session-table.schemas"
import {
  cancelSessionSchema,
  createSessionSchema,
  openingCashSchema,
  openSessionSchema,
  sessionsQuerySchema,
} from "@/modules/sessions/session.schemas"
import {
  ACTIVE_SESSION_STATUSES,
  canManagePreparation,
  canTransition,
  isActiveSessionStatus,
  isSuperadminIntervention,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
} from "@/modules/sessions/session.state"

const KEY = "clave-12345678"

describe("máquina de estados de sesión (Módulo 06)", () => {
  it("una sesión nace en DRAFT y solo avanza a PREPARATION o se cancela", () => {
    expect(SESSION_TRANSITIONS.DRAFT).toEqual(["PREPARATION", "CANCELLED"])
    expect(canTransition("DRAFT", "PREPARATION")).toBe(true)
    expect(canTransition("DRAFT", "OPEN")).toBe(false) // no se omite la preparación
  })

  it("PREPARATION → OPEN o CANCELLED; OPEN → CLOSING → CLOSED; CLOSING → OPEN (Módulo 12)", () => {
    expect(canTransition("PREPARATION", "OPEN")).toBe(true)
    expect(canTransition("PREPARATION", "CANCELLED")).toBe(true)
    expect(canTransition("OPEN", "CLOSING")).toBe(true)
    expect(canTransition("CLOSING", "CLOSED")).toBe(true)
    // Regreso auditado para registrar operaciones reales olvidadas (DEC-10).
    expect(canTransition("CLOSING", "OPEN")).toBe(true)
  })

  it("rechaza las transiciones prohibidas (una sesión CLOSED nunca se reabre)", () => {
    for (const [from, to] of [
      ["OPEN", "PREPARATION"],
      ["CLOSED", "OPEN"],
      ["CLOSED", "CLOSING"],
      ["CANCELLED", "OPEN"],
      ["CLOSED", "DRAFT"],
      ["OPEN", "CANCELLED"],
      ["OPEN", "CLOSED"],
      ["CLOSING", "CANCELLED"],
    ] as const) {
      expect(canTransition(from, to)).toBe(false)
    }
    expect(SESSION_TRANSITIONS.CLOSED).toEqual([])
    expect(SESSION_TRANSITIONS.CANCELLED).toEqual([])
  })

  it("vigentes: DRAFT, PREPARATION, OPEN y CLOSING; terminales: CLOSED y CANCELLED", () => {
    expect([...ACTIVE_SESSION_STATUSES].sort()).toEqual([
      "CLOSING",
      "DRAFT",
      "OPEN",
      "PREPARATION",
    ])
    expect(isActiveSessionStatus("CLOSED")).toBe(false)
    expect(isActiveSessionStatus("CANCELLED")).toBe(false)
    expect(SESSION_STATUSES).toHaveLength(6)
  })
})

describe("regla del creador", () => {
  const session = { createdById: "creador" }
  it("el creador continúa su preparación; otro usuario del mismo rol no", () => {
    expect(
      canManagePreparation({ id: "creador", role: "CASHIER" }, session)
    ).toBe(true)
    expect(canManagePreparation({ id: "otro", role: "CASHIER" }, session)).toBe(
      false
    )
    expect(canManagePreparation({ id: "otro", role: "PARTNER" }, session)).toBe(
      false
    )
  })

  it("SUPERADMIN puede intervenir y se identifica como intervención", () => {
    expect(
      canManagePreparation({ id: "admin", role: "SUPERADMIN" }, session)
    ).toBe(true)
    expect(
      isSuperadminIntervention({ id: "admin", role: "SUPERADMIN" }, session)
    ).toBe(true)
    expect(
      isSuperadminIntervention(
        { id: "creador", role: "SUPERADMIN" },
        { createdById: "creador" }
      )
    ).toBe(false)
  })

  it("los tres roles crean, consultan y operan sesiones y mesas", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.SESSIONS_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.SESSIONS_MANAGE)).toBe(true)
    }
  })
})

describe("validación de entradas de sesión", () => {
  it("crear: solo clave y notas; nunca creador, folio, estado ni fechas", () => {
    expect(createSessionSchema.safeParse({ idempotencyKey: KEY }).success).toBe(
      true
    )
    for (const extra of [
      { createdById: "x" },
      { folio: "SES-1" },
      { status: "OPEN" },
      { openedAt: "2026-01-01" },
    ]) {
      expect(
        createSessionSchema.safeParse({ idempotencyKey: KEY, ...extra }).success
      ).toBe(false)
    }
    expect(createSessionSchema.safeParse({}).success).toBe(false) // idempotencia obligatoria
  })

  it("abrir: el frontend no envía openedAt (fecha automática del servidor)", () => {
    expect(openSessionSchema.safeParse({ idempotencyKey: KEY }).success).toBe(
      true
    )
    expect(
      openSessionSchema.safeParse({
        idempotencyKey: KEY,
        openedAt: new Date().toISOString(),
      }).success
    ).toBe(false)
  })

  it("caja inicial: exige la verificación física; si hay dinero, explicar su procedencia", () => {
    expect(
      openingCashSchema.safeParse({
        countedAmount: "0",
        physicallyVerified: true,
      }).success
    ).toBe(true)
    expect(
      openingCashSchema.safeParse({
        countedAmount: "0",
        physicallyVerified: false,
      }).success
    ).toBe(false)
    expect(openingCashSchema.safeParse({ countedAmount: "0" }).success).toBe(
      false
    )
    expect(
      openingCashSchema.safeParse({
        countedAmount: "150",
        physicallyVerified: true,
      }).success
    ).toBe(false)
    expect(
      openingCashSchema.safeParse({
        countedAmount: "150",
        physicallyVerified: true,
        explanation: "Billetes olvidados",
      }).success
    ).toBe(true)
    expect(
      openingCashSchema.safeParse({
        countedAmount: "-5",
        physicallyVerified: true,
      }).success
    ).toBe(false)
    expect(
      openingCashSchema.safeParse({
        countedAmount: "0",
        physicallyVerified: true,
        expectedAmount: "100",
      }).success
    ).toBe(false)
  })

  it("cancelar exige motivo", () => {
    expect(cancelSessionSchema.safeParse({}).success).toBe(false)
    expect(cancelSessionSchema.safeParse({ reason: "no" }).success).toBe(false)
    expect(
      cancelSessionSchema.safeParse({ reason: "Se suspende la noche" }).success
    ).toBe(true)
  })

  it("consulta: orden y paginación por defecto", () => {
    expect(sessionsQuerySchema.parse({})).toMatchObject({
      sort: "desc",
      page: 1,
      pageSize: 20,
    })
    expect(sessionsQuerySchema.safeParse({ status: "BORRADOR" }).success).toBe(
      false
    )
  })
})

describe("sesiones que cruzan medianoche", () => {
  it("la fecha se guarda en UTC y se muestra en la hora de Monterrey; el cambio de día no crea otra sesión", () => {
    const start = "2026-10-18T03:00:00.000Z" // sábado 17, 21:00 en Monterrey
    const open = "2026-10-18T07:30:00.000Z" // domingo 18, 01:30 en Monterrey
    expect(businessDateOf(start)).toBe("2026-10-17")
    expect(businessDateOf(open)).toBe("2026-10-18")
    expect(formatDateTime(open)).toMatch(/1:30/)
    // Precisión de milisegundos conservada (TIME-07).
    expect(new Date("2026-10-18T07:30:00.123Z").toISOString()).toBe(
      "2026-10-18T07:30:00.123Z"
    )
  })
})

describe("mesas y participación (Módulo 07)", () => {
  it("abrir/cerrar: solo clave (y notas al cerrar); nunca fechas ni responsables", () => {
    expect(openTableSchema.safeParse({ idempotencyKey: KEY }).success).toBe(
      true
    )
    expect(
      openTableSchema.safeParse({ idempotencyKey: KEY, openedAt: "2026-01-01" })
        .success
    ).toBe(false)
    expect(
      closeTableSchema.safeParse({ idempotencyKey: KEY, notes: "Fin" }).success
    ).toBe(true)
    expect(
      closeTableSchema.safeParse({ idempotencyKey: KEY, closedById: "x" })
        .success
    ).toBe(false)
  })

  it("registrar jugador: solo playerId y clave", () => {
    expect(
      addPlayerSchema.safeParse({ playerId: "p1", idempotencyKey: KEY }).success
    ).toBe(true)
    for (const extra of [
      { joinedAt: "x" },
      { joinedById: "x" },
      { status: "SETTLED" },
      { sessionTableCycleId: "c" },
    ]) {
      expect(
        addPlayerSchema.safeParse({
          playerId: "p1",
          idempotencyKey: KEY,
          ...extra,
        }).success
      ).toBe(false)
    }
  })

  it("transferir: origen, mesa destino y clave; no pide fichas, denominaciones ni importes", () => {
    expect(
      transferSchema.safeParse({
        sourceParticipationId: "a",
        destinationTableId: "b",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
    for (const extra of [
      { amount: "100" },
      { chips: [] },
      { playerId: "x" },
      { sourceTableId: "x" },
    ]) {
      expect(
        transferSchema.safeParse({
          sourceParticipationId: "a",
          destinationTableId: "b",
          idempotencyKey: KEY,
          ...extra,
        }).success
      ).toBe(false)
    }
  })

  it("historial: filtros por ciclo y fecha", () => {
    expect(
      historyQuerySchema.parse({ cycle: "2", from: "2026-10-17" })
    ).toMatchObject({ cycle: 2 })
    expect(historyQuerySchema.safeParse({ cycle: "0" }).success).toBe(false)
  })
})

describe("inventario nominal (corrección de compras por importe)", () => {
  it("el importe es obligatorio, positivo y con máximo dos decimales (Decimal, nunca Float)", () => {
    expect(parseNominalAmount("5000").toFixed(2)).toBe("5000.00")
    expect(
      parseNominalAmount("0.10").add(parseNominalAmount("0.20")).toFixed(2)
    ).toBe("0.30")
    expect(() => parseNominalAmount("0")).toThrow(/mayor que cero/)
    expect(() => parseNominalAmount("-5")).toThrow(/mayor que cero/)
    expect(() => parseNominalAmount("1.234")).toThrow(/dos decimales/)
    expect(() => parseNominalAmount("abc")).toThrow()
  })

  it("disponible = custodia − reservado (lo reservado sigue en custodia)", () => {
    expect(
      nominalAvailable(
        new Prisma.Decimal("12500"),
        new Prisma.Decimal("5000")
      ).toFixed(2)
    ).toBe("7500.00")
  })

  it("las reglas fijas registran el inventario compartido", () => {
    expect(OPERATIONAL_RULES.map((r) => r.id)).toContain(
      "SHARED_CHIP_INVENTORY"
    )
  })
})
