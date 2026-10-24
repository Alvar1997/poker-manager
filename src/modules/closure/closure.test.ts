import { describe, expect, it } from "vitest"

import { Prisma } from "@/generated/prisma/client"
import { roleHasPermission, PERMISSIONS } from "@/config/permission-matrix"
import {
  closureReportLines,
  closureReportText,
  type ClosureReportContent,
} from "@/modules/closure/closure-report.content"
import {
  assertExactWithdrawal,
  cashFromEntries,
  chipPosition,
  circulationByPlayer,
  circulationFlows,
  closureKindFor,
  custodyFlows,
  evaluateReadiness,
  identifiableReturn,
  individualResult,
  sessionChipReconciliation,
  requiresNoActivityReason,
  sortFindings,
  summarizeFindings,
  type Finding,
  type ReadinessFacts,
} from "@/modules/closure/closure.math"
import {
  cashCountSchema,
  cashWithdrawalSchema,
  confirmClosureSchema,
  resolveDiscrepancySchema,
  returnToOpenSchema,
  startClosingSchema,
} from "@/modules/closure/closure.schemas"
import { canTransition } from "@/modules/sessions/session.state"

const D = (v: string | number) => new Prisma.Decimal(v)
const KEY = "clave-12345678"

/** Hechos de un cierre listo (se modifican por caso). */
function ready(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    sessionStatus: "CLOSING",
    closureStatus: "IN_PROGRESS",
    kind: "NORMAL",
    noActivityReason: null,
    openCycles: 0,
    blockingFindings: 0,
    chipCount: {
      status: "CONFIRMED",
      reconciliationStatus: "NOT_REQUIRED",
      current: true,
    },
    openingCountCurrent: false,
    openChipDiscrepancies: 0,
    cashCount: {
      differenceStatus: "NOT_REQUIRED",
      balanceVersion: 7,
      adjusted: false,
      countedAmount: D(1000),
    },
    openCashDiscrepancies: 0,
    cashVersion: 8,
    cashBalance: D(0),
    withdrawal: { amount: D(1000) },
    ...overrides,
  }
}
const failing = (f: ReadinessFacts) =>
  evaluateReadiness(f)
    .checks.filter((c) => !c.ok)
    .map((c) => c.id)

describe("estados de la sesión (Módulo 12)", () => {
  it("OPEN → CLOSING, CLOSING → OPEN (regreso) y CLOSING → CLOSED; nunca CLOSED → OPEN/CLOSING", () => {
    expect(canTransition("OPEN", "CLOSING")).toBe(true)
    expect(canTransition("CLOSING", "OPEN")).toBe(true)
    expect(canTransition("CLOSING", "CLOSED")).toBe(true)
    expect(canTransition("CLOSED", "OPEN")).toBe(false)
    expect(canTransition("CLOSED", "CLOSING")).toBe(false)
    expect(canTransition("CANCELLED", "OPEN")).toBe(false)
  })
})

describe("prevalidación", () => {
  const f = (
    code: Finding["code"],
    severity: Finding["severity"]
  ): Finding => ({
    code,
    severity,
    title: code,
    detail: "",
  })

  it("solo los BLOCKING impiden cerrar: deudas y pagos pendientes son advertencias; la diferencia nominal global bloquea", () => {
    const s = summarizeFindings([
      f("PLAYER_DEBTS_OUTSTANDING", "WARNING"),
      f("PAYABLES_PENDING", "WARNING"),
      f("CHIPS_RECONCILED", "INFO"),
      f("GLOBAL_CIRCULATION", "INFO"),
    ])
    expect(s).toEqual({ blocking: 0, warnings: 2, info: 2, clear: true })
    expect(
      summarizeFindings([f("SESSION_NOMINAL_DIFFERENCE", "BLOCKING")]).clear
    ).toBe(false)
    expect(
      summarizeFindings([f("ACTIVE_PARTICIPANTS", "BLOCKING")]).clear
    ).toBe(false)
  })

  it("ordena bloqueos primero (determinista)", () => {
    const sorted = sortFindings([
      f("CASH_BALANCE", "INFO"),
      f("PAYABLES_PENDING", "WARNING"),
      f("OPEN_TABLES", "BLOCKING"),
    ])
    expect(sorted.map((x) => x.severity)).toEqual([
      "BLOCKING",
      "WARNING",
      "INFO",
    ])
  })

  it("sesión sin ciclos de mesa = cierre SIN ACTIVIDAD con motivo obligatorio", () => {
    expect(closureKindFor(0)).toBe("NO_ACTIVITY")
    expect(closureKindFor(2)).toBe("NORMAL")
    expect(requiresNoActivityReason("NO_ACTIVITY", null)).toBe(true)
    expect(requiresNoActivityReason("NO_ACTIVITY", "   ")).toBe(true)
    expect(requiresNoActivityReason("NO_ACTIVITY", "No llegó nadie")).toBe(
      false
    )
    expect(requiresNoActivityReason("NORMAL", null)).toBe(false)
  })
})

describe("fichas: circulación vs diferencia física (regla crítica)", () => {
  const row = (
    type: string,
    custody: [number, number],
    circulation: [number, number],
    playerId: string | null = null
  ) => ({
    movementType: type,
    custodyBefore: D(custody[0]),
    custodyAfter: D(custody[1]),
    circulationBefore: D(circulation[0]),
    circulationAfter: D(circulation[1]),
    playerId,
  })
  const night = [
    row("CHIP_DELIVERY", [100000, 35000], [0, 65000], "a"),
    row("CHIP_RETURN", [35000, 97000], [65000, 3000], "a"),
  ]

  it("entregado $65,000 − devuelto $62,000 = $3,000 no retornados (circulación)", () => {
    const flows = circulationFlows(night)
    expect(flows.delivered.toFixed(2)).toBe("65000.00")
    expect(flows.returned.toFixed(2)).toBe("62000.00")
    expect(flows.net.toFixed(2)).toBe("3000.00")
  })

  it("esperado $97,000 = contado $97,000: arqueo cuadrado aunque haya $3,000 fuera de custodia", () => {
    const p = chipPosition({
      expectedCustody: D(97000),
      countedCustody: D(97000),
      sessionNetNotReturned: D(3000),
      globalCirculation: D(3000),
    })
    expect(p.physicalStatus).toBe("MATCH")
    expect(p.physicalDifference?.toFixed(2)).toBe("0.00")
    expect(p.sessionNetNotReturned.toFixed(2)).toBe("3000.00")
    // Nunca se reconoce como ingreso ni utilidad.
    expect(p.recognizedAsIncome.toFixed(2)).toBe("0.00")
  })

  it("contado $96,500 vs esperado $97,000: diferencia FÍSICA de −$500 (distinta de la circulación)", () => {
    const p = chipPosition({
      expectedCustody: D(97000),
      countedCustody: D(96500),
      sessionNetNotReturned: D(3000),
      globalCirculation: D(3000),
    })
    expect(p.physicalStatus).toBe("SHORTAGE")
    expect(p.physicalDifference?.toFixed(2)).toBe("-500.00")
    expect(p.globalCirculation.toFixed(2)).toBe("3000.00")
  })

  it("sin conteo no hay diferencia física", () => {
    expect(
      chipPosition({
        expectedCustody: D(1),
        countedCustody: null,
        sessionNetNotReturned: D(0),
        globalCirculation: D(0),
      }).physicalStatus
    ).toBe("NOT_COUNTED")
  })

  it("la atribución por jugador es informativa y los ajustes no tocan la circulación", () => {
    const rows = [
      ...night,
      row("CHIP_DELIVERY", [97000, 96000], [3000, 4000], "b"),
      row("INVENTORY_ADJUSTMENT", [96000, 95500], [4000, 4000]),
    ]
    const byPlayer = circulationByPlayer(rows)
    expect(byPlayer.find((p) => p.playerId === "a")?.net.toFixed(2)).toBe(
      "3000.00"
    )
    expect(byPlayer.find((p) => p.playerId === "b")?.net.toFixed(2)).toBe(
      "1000.00"
    )
    expect(circulationFlows(rows).net.toFixed(2)).toBe("4000.00")
    const custody = custodyFlows(rows)
    expect(custody.byType.deliveries.toFixed(2)).toBe("-66000.00")
    expect(custody.byType.returns.toFixed(2)).toBe("62000.00")
    expect(custody.byType.adjustments.toFixed(2)).toBe("-500.00")
    expect(custody.total.toFixed(2)).toBe("-4500.00")
  })
})

describe("efectivo", () => {
  it("esperado = entradas − salidas confirmadas", () => {
    const r = cashFromEntries([
      { direction: "DEBIT", amount: D(7000) },
      { direction: "CREDIT", amount: D(6000) },
    ])
    expect(r.balance.toFixed(2)).toBe("1000.00")
  })

  it("el retiro final debe ser EXACTAMENTE lo disponible; nunca más ni negativo", () => {
    expect(assertExactWithdrawal(D(1000), D(1000))).toBeNull()
    expect(assertExactWithdrawal(D(1500), D(1000))).toMatch(/más efectivo/)
    expect(assertExactWithdrawal(D(900), D(1000))).toMatch(/\$0\.00/)
    expect(assertExactWithdrawal(D(0), D(1000))).toMatch(/mayor que cero/)
    expect(assertExactWithdrawal(D(10), D(-5))).toMatch(/negativo/)
  })
})

describe("requisitos del cierre definitivo", () => {
  it("listo: todo resuelto, retiro registrado y caja en $0", () => {
    expect(evaluateReadiness(ready()).ready).toBe(true)
  })

  it("bloquea con mesas abiertas, bloqueos de prevalidación o sesión fuera de CLOSING", () => {
    expect(failing(ready({ openCycles: 1 }))).toContain("TABLES_CLOSED")
    expect(failing(ready({ blockingFindings: 2 }))).toContain("NO_BLOCKING")
    expect(failing(ready({ sessionStatus: "OPEN" }))).toContain(
      "SESSION_CLOSING"
    )
  })

  it("un arqueo desactualizado o ausente bloquea; una diferencia física NO (Módulo 18: se cierra con motivo)", () => {
    const f = failing(
      ready({
        chipCount: {
          status: "CONFIRMED",
          reconciliationStatus: "PENDING",
          current: false,
        },
        openChipDiscrepancies: 1,
      })
    )
    expect(f).toContain("CHIP_COUNT")
    expect(f).not.toContain("CHIP_DIFFERENCES")
    expect(
      failing(
        ready({
          chipCount: {
            status: "CONFIRMED",
            reconciliationStatus: "PENDING",
            current: true,
          },
          openChipDiscrepancies: 1,
        })
      )
    ).toEqual([])
    expect(failing(ready({ chipCount: null }))).toContain("CHIP_COUNT")
  })

  it("un ajuste autorizado resuelve la diferencia", () => {
    expect(
      evaluateReadiness(
        ready({
          chipCount: {
            status: "CONFIRMED",
            reconciliationStatus: "RECONCILED",
            current: true,
          },
        })
      ).ready
    ).toBe(true)
  })

  it("efectivo: sin arqueo, con diferencia, con movimientos posteriores, sin retiro o con saldo ≠ 0 → no listo", () => {
    expect(failing(ready({ cashCount: null }))).toContain("CASH_COUNT")
    expect(
      failing(
        ready({
          cashCount: {
            differenceStatus: "PENDING",
            balanceVersion: 7,
            adjusted: false,
            countedAmount: D(950),
          },
        })
      )
    ).toContain("CASH_DIFFERENCES")
    expect(failing(ready({ cashVersion: 9 }))).toContain("CASH_UNCHANGED")
    expect(
      failing(ready({ withdrawal: null, cashVersion: 7, cashBalance: D(1000) }))
    ).toEqual(expect.arrayContaining(["CASH_WITHDRAWN", "CASH_ZERO"]))
  })

  it("caja contada en $0: no exige retiro", () => {
    expect(
      evaluateReadiness(
        ready({
          cashCount: {
            differenceStatus: "NOT_REQUIRED",
            balanceVersion: 3,
            adjusted: false,
            countedAmount: D(0),
          },
          cashVersion: 3,
          withdrawal: null,
        })
      ).ready
    ).toBe(true)
  })

  it("sin actividad: vale el arqueo de apertura vigente y exige motivo", () => {
    const base = ready({
      kind: "NO_ACTIVITY",
      chipCount: null,
      openingCountCurrent: true,
      cashCount: {
        differenceStatus: "NOT_REQUIRED",
        balanceVersion: 0,
        adjusted: false,
        countedAmount: D(0),
      },
      cashVersion: 0,
      withdrawal: null,
    })
    expect(failing(base)).toEqual(["NO_ACTIVITY_REASON"])
    expect(
      evaluateReadiness({ ...base, noActivityReason: "No llegaron jugadores" })
        .ready
    ).toBe(true)
  })
})

describe("autorización", () => {
  it("CASHIER prepara pero no confirma ni autoriza ajustes; PARTNER y SUPERADMIN sí", () => {
    expect(roleHasPermission("CASHIER", PERMISSIONS.SESSIONS_MANAGE)).toBe(true)
    expect(
      roleHasPermission("CASHIER", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(false)
    expect(
      roleHasPermission("PARTNER", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(true)
    expect(
      roleHasPermission("SUPERADMIN", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(true)
  })
})

describe("schemas del cierre", () => {
  it("el cliente no envía esperados, estados, autorizadores ni 'aprobado'", () => {
    expect(
      startClosingSchema.safeParse({ idempotencyKey: KEY, status: "CLOSED" })
        .success
    ).toBe(false)
    expect(
      confirmClosureSchema.safeParse({
        idempotencyKey: KEY,
        previewHash: "a".repeat(64),
        approvedBy: "x",
      }).success
    ).toBe(false)
    expect(
      cashCountSchema.safeParse({
        countedAmount: "100",
        physicallyCounted: true,
        expectedAmount: "100",
      }).success
    ).toBe(false)
  })

  it("regreso a OPEN exige motivo", () => {
    expect(
      returnToOpenSchema.safeParse({ idempotencyKey: KEY, reason: "" }).success
    ).toBe(false)
    expect(
      returnToOpenSchema.safeParse({
        idempotencyKey: KEY,
        reason: "Faltó una recompra real",
      }).success
    ).toBe(true)
  })

  it("retiro: receptor obligatorio y entrega física declarada; sin firma ni confirmación del receptor", () => {
    const base = {
      idempotencyKey: KEY,
      amount: "1000",
      recipientName: "Socio Juan",
      physicallyDelivered: true,
    }
    expect(cashWithdrawalSchema.safeParse(base).success).toBe(true)
    expect(
      cashWithdrawalSchema.safeParse({ ...base, recipientName: "" }).success
    ).toBe(false)
    expect(
      cashWithdrawalSchema.safeParse({ ...base, physicallyDelivered: false })
        .success
    ).toBe(false)
    expect(
      cashWithdrawalSchema.safeParse({ ...base, recipientSignature: "x" })
        .success
    ).toBe(false)
    expect(
      cashWithdrawalSchema.safeParse({ ...base, amount: "-5" }).success
    ).toBe(false)
  })

  it("el conteo de efectivo no admite negativos ni fracciones de centavo", () => {
    for (const v of ["-1", "1.234", "abc"])
      expect(
        cashCountSchema.safeParse({
          countedAmount: v,
          physicallyCounted: true,
        }).success
      ).toBe(false)
  })

  it("resolver una diferencia: nota o ajuste con motivo", () => {
    expect(
      resolveDiscrepancySchema.safeParse({
        action: "authorize-adjustment",
        idempotencyKey: KEY,
        reason: "x",
      }).success
    ).toBe(false)
    expect(
      resolveDiscrepancySchema.safeParse({ action: "delete" }).success
    ).toBe(false)
  })
})

describe("comprobante de cierre", () => {
  const content: ClosureReportContent = {
    version: "2026-10-cierre-v1",
    folio: "CIE-000001",
    kind: "NORMAL",
    noActivityReason: null,
    session: {
      id: "s1",
      folio: "SES-000001",
      openedAt: "2026-10-26T02:00:00.000Z",
      closingStartedAt: "2026-10-26T08:00:00.000Z",
      closedAt: "2026-10-26T08:30:00.000Z",
    },
    preparedBy: { id: "u1", name: "Cajero" },
    approvedBy: { id: "u2", name: "Socio", role: "PARTNER" },
    approvedAt: "2026-10-26T08:30:00.000Z",
    attempts: [],
    tables: {
      operated: 2,
      names: ["10/10", "25/25"],
      cyclesClosed: 2,
      cycles: [],
    },
    players: 2,
    purchases: {
      initialCount: 2,
      initialNominal: "8000.00",
      rebuyCount: 1,
      rebuyNominal: "2000.00",
      paidCash: "7000.00",
      paidTransferConfirmed: "0.00",
      paidTransferPending: "0.00",
      paidCardApproved: "0.00",
    },
    credits: { originated: "3000.00", outstanding: "3000.00" },
    abonos: { cash: "0.00", transferConfirmed: "0.00", card: "0.00" },
    settlements: {
      completed: 1,
      pendingPayout: 1,
      returnedNominal: "7000.00",
      offsets: "0.00",
      paidCash: "6000.00",
      paidTransfer: "0.00",
      transferInTransit: "0.00",
      pendingAmount: "1000.00",
      pendingPlayers: 1,
    },
    inventory: {
      chipCountId: "c1",
      expectedCustody: "97000.00",
      countedCustody: "97000.00",
      physicalDifference: "0.00",
      adjustments: [],
      sessionDelivered: "10000.00",
      sessionReturned: "7000.00",
      sessionNetNotReturned: "3000.00",
      globalCirculation: "3000.00",
    },
    cash: {
      cashCountId: "r1",
      expected: "1000.00",
      counted: "1000.00",
      difference: "0.00",
      adjustments: [],
      withdrawal: {
        amount: "1000.00",
        recipientName: "Socio Juan",
        withdrawnBy: "Cajero",
        withdrawalAt: "2026-10-26T08:20:00.000Z",
        folio: "MOV-000010",
      },
      final: "0.00",
    },
    bank: {
      incomingConfirmed: "0.00",
      incomingPending: "0.00",
      outgoingExecuted: "0.00",
      outgoingPending: "0.00",
    },
    card: { approvedInSession: "0.00", clearingGlobal: "0.00" },
    incidents: [],
    previewDigest: "a".repeat(64),
  }

  it("muestra por separado la diferencia física, lo no retornado y la circulación; nunca 'utilidad'", () => {
    const labels = closureReportLines(content).map((l) => l.label)
    expect(labels).toEqual(
      expect.arrayContaining([
        "Diferencia física de arqueo",
        "Valor no retornado (pendiente)",
        "Circulación global de fichas",
        "Retiro final",
        "Caja final",
        "Deudas de jugadores pendientes",
        "Pagos pendientes a jugadores",
        "Preparó",
        "Confirmó (autorizó)",
      ])
    )
    const text = closureReportText(content)
    expect(text).not.toMatch(/utilidad neta|ganancia/i)
    expect(text).toMatch(/Socio Juan/)
    // Sin PDF ni enlaces.
    expect(text).not.toMatch(/pdf|https?:\/\//i)
  })

  it("el cierre sin actividad muestra su motivo", () => {
    const lines = closureReportLines({
      ...content,
      kind: "NO_ACTIVITY",
      noActivityReason: "No llegaron jugadores",
    })
    expect(lines).toContainEqual({
      label: "Motivo (sin actividad)",
      value: "No llegaron jugadores",
    })
  })
})

describe("conciliación GLOBAL de fichas (nadie se lleva fichas)", () => {
  const D2 = (v: string | number) => new Prisma.Decimal(v)
  const rec = (
    delivered: string,
    returned: string,
    active = 0,
    authorized = "0"
  ) =>
    sessionChipReconciliation({
      delivered: D2(delivered),
      returned: D2(returned),
      authorizedUnrecovered: D2(authorized),
      activeParticipants: active,
    })
  const row = (delta: number, playerId: string) => ({
    movementType: delta > 0 ? "CHIP_DELIVERY" : "CHIP_RETURN",
    custodyBefore: "0",
    custodyAfter: String(-delta),
    circulationBefore: "0",
    circulationAfter: String(delta),
    playerId,
  })

  it("Juan compra 5,000 y devuelve 2,000 (−3,000); Pedro compra 5,000 y devuelve 8,000 (+3,000): balance global $0, sin alerta", () => {
    const rows = [
      row(5000, "juan"),
      row(5000, "pedro"),
      row(-2000, "juan"),
      row(-8000, "pedro"),
    ]
    const flows = circulationFlows(rows)
    expect(flows.delivered.toFixed(2)).toBe("10000.00")
    expect(flows.returned.toFixed(2)).toBe("10000.00")
    const r = rec(flows.delivered.toFixed(2), flows.returned.toFixed(2))
    expect(r.status).toBe("RECONCILED")
    expect(r.difference.toFixed(2)).toBe("0.00")
    const players = circulationByPlayer(rows)
    const juan = players.find((p) => p.playerId === "juan")!
    const pedro = players.find((p) => p.playerId === "pedro")!
    expect(individualResult(juan.returned, juan.delivered).toFixed(2)).toBe(
      "-3000.00"
    )
    expect(individualResult(pedro.returned, pedro.delivered).toFixed(2)).toBe(
      "3000.00"
    )
  })

  it("retorno cero (−5,000) y ganador que devuelve el doble (+5,000): conciliado", () => {
    expect(rec("10000", "10000").status).toBe("RECONCILED")
    expect(individualResult(D2(0), D2(5000)).toFixed(2)).toBe("-5000.00")
    expect(individualResult(D2(12000), D2(5000)).toFixed(2)).toBe("7000.00")
  })

  it("con jugadores activos las fichas están EN JUEGO (no es diferencia)", () => {
    expect(rec("10000", "4000", 2).status).toBe("IN_PLAY")
  })

  it("100,000 entregados y 95,000 devueltos con todos terminados: 5,000 por conciliar (no «en circulación»)", () => {
    const r = rec("100000", "95000")
    expect(r.status).toBe("UNEXPLAINED_DIFFERENCE")
    expect(r.difference.toFixed(2)).toBe("5000.00")
    // Una diferencia autorizada la concilia sin inventar retornos.
    expect(rec("100000", "95000", 0, "5000").status).toBe("RECONCILED")
  })

  it("devolver más de lo entregado en la sesión: proviene de circulación anterior", () => {
    expect(rec("1000", "1500").status).toBe("PRIOR_CIRCULATION_RETURNED")
  })

  it("retorno identificado solo hasta lo que el arqueo encontró de más", () => {
    expect(
      identifiableReturn({
        physicalSurplus: D2(3000),
        pendingDifference: D2(5000),
      }).toFixed(2)
    ).toBe("3000.00")
    expect(
      identifiableReturn({
        physicalSurplus: D2(8000),
        pendingDifference: D2(5000),
      }).toFixed(2)
    ).toBe("5000.00")
    expect(
      identifiableReturn({
        physicalSurplus: D2(0),
        pendingDifference: D2(5000),
      }).toFixed(2)
    ).toBe("0.00")
    expect(
      identifiableReturn({
        physicalSurplus: null,
        pendingDifference: D2(5000),
      }).toFixed(2)
    ).toBe("0.00")
  })
})
