import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { moduleOfAction } from "@/modules/audit/audit-taxonomy"
import {
  chipDestinations,
  sessionChipReconciliation,
} from "@/modules/closure/closure.math"
import { confirmClosureSchema } from "@/modules/closure/closure.schemas"
import {
  cycleRake,
  dec as rdec,
  rakeModeChangeBlocker,
  runningTotals,
} from "@/modules/rake/rake.math"
import {
  rakeCorrectionSchema,
  rakeEntrySchema,
} from "@/modules/rake/rake.schemas"

import { dec, staffTipFigures, tipsTotal } from "./tips.math"
import { confirmTipCountSchema, saveTipCountSchema } from "./tips.schemas"

const row = (referenceType: string | null, delta: number) => ({
  referenceType,
  circulationBefore: "100000",
  circulationAfter: String(100000 + delta),
})

describe("rake (puro)", () => {
  it("manual: acumulado con hora; comprobación con diferencia; corrección suma ±", () => {
    const rows = runningTotals(
      ["50", "75", "100"].map((a) => ({ amount: rdec(a) }))
    )
    expect(rows.map((x) => x.cumulative.toFixed(2))).toEqual([
      "50.00",
      "125.00",
      "225.00",
    ])
    const r = cycleRake({
      mode: "MANUAL",
      cycleClosed: true,
      entries: rows.map((x) => x.amount),
      corrections: [],
      count: { counted: rdec(200) },
    })
    expect([
      r.recognized.toFixed(2),
      r.difference?.toFixed(2),
      r.status,
    ]).toEqual(["225.00", "-25.00", "DIFFERENCE"])
    const fixed = cycleRake({
      mode: "MANUAL",
      cycleClosed: true,
      entries: [rdec(225)],
      corrections: [rdec(-25)],
      count: { counted: rdec(200) },
    })
    expect([fixed.recognized.toFixed(2), fixed.status]).toEqual([
      "200.00",
      "RECONCILED",
    ])
    expect(
      cycleRake({
        mode: "MANUAL",
        cycleClosed: true,
        entries: [rdec(5)],
        corrections: [],
        count: null,
      }).status
    ).toBe("NOT_VERIFIED")
  })
  it("conteo final: el conteo es el rake; sin conteo, pendiente ($0)", () => {
    expect(
      cycleRake({
        mode: "FINAL_COUNT",
        cycleClosed: true,
        entries: [],
        corrections: [],
        count: { counted: rdec(8000) },
      }).recognized.toFixed(2)
    ).toBe("8000.00")
    const p = cycleRake({
      mode: "FINAL_COUNT",
      cycleClosed: true,
      entries: [],
      corrections: [],
      count: null,
    })
    expect([p.recognized.toFixed(2), p.status]).toEqual([
      "0.00",
      "COUNT_PENDING",
    ])
    expect(rakeModeChangeBlocker({ openCycles: 1 })).toMatch(/abierta/)
    expect(rakeModeChangeBlocker({ openCycles: 0 })).toBeNull()
  })
  it("esquemas: sin hora real ni responsable del cliente; corrección con motivo", () => {
    expect(
      rakeEntrySchema.safeParse({
        amount: "50",
        idempotencyKey: "abcdefgh1",
        recordedAt: "x",
      }).success
    ).toBe(false)
    expect(
      rakeCorrectionSchema.safeParse({
        cycleId: "c1",
        amount: "-25",
        idempotencyKey: "abcdefgh1",
      }).success
    ).toBe(false)
    expect(
      rakeCorrectionSchema.safeParse({
        cycleId: "c1",
        amount: "-25",
        reason: "Captura duplicada",
        idempotencyKey: "abcdefgh1",
      }).success
    ).toBe(true)
  })
})

describe("propinas (puro)", () => {
  it("solo el conteo CONFIRMADO cuenta; parciales y borradores no; correcciones se suman", () => {
    expect(
      staffTipFigures({
        count: { status: "DRAFT", amount: dec(700) },
        entries: [],
      }).recognized.toFixed(2)
    ).toBe("0.00")
    const f = staffTipFigures({
      count: { status: "CONFIRMED", amount: dec(1500) },
      entries: [
        { kind: "PARTIAL", amount: dec(500) },
        { kind: "CORRECTION", amount: dec(-25) },
      ],
    })
    expect([
      f.recognized.toFixed(2),
      f.partials.toFixed(2),
      f.countVsPartials?.toFixed(2),
    ]).toEqual(["1475.00", "500.00", "1000.00"])
    expect(
      staffTipFigures({
        count: { status: "CONFIRMED", amount: dec(0) },
        entries: [],
      }).recognized.toFixed(2)
    ).toBe("0.00")
    const total = tipsTotal(
      ["1500", "1000", "800", "700"].map((a) => ({ recognized: dec(a) }))
    )
    expect(total.toFixed(2)).toBe("4000.00")
  })
  it("esquemas: el cliente no envía estado ni totales; confirmar exige recepción física", () => {
    expect(
      saveTipCountSchema.safeParse({ amount: "100", status: "CONFIRMED" })
        .success
    ).toBe(false)
    expect(
      confirmTipCountSchema.safeParse({ expectedVersion: 1, amount: "100" })
        .success
    ).toBe(false)
  })
})

describe("conciliación global (puro)", () => {
  it("entregado = jugadores + rake + propinas + diferencia; corrección negativa de rake no es entrega", () => {
    const d = chipDestinations([
      row("PurchaseDelivery", 100000),
      row("PlayerSettlement", -80000),
      row("RakeMovement", -4000),
      row("RakeCount", -8000),
      row("RakeMovement", 50), // corrección −50 → vuelve a circulación
      row("StaffTipCount", -7975),
    ])
    expect(
      [d.deliveredToPlayers, d.returnedByPlayers, d.rake, d.tips].map((x) =>
        x.toFixed(2)
      )
    ).toEqual(["100000.00", "80000.00", "11950.00", "7975.00"])
    const exact = sessionChipReconciliation({
      delivered: dec(100000),
      returned: dec(100000),
      authorizedUnrecovered: dec(0),
      activeParticipants: 0,
    })
    expect(exact.status).toBe("RECONCILED")
    const missing = sessionChipReconciliation({
      delivered: dec(100000),
      returned: dec(99975),
      authorizedUnrecovered: dec(0),
      activeParticipants: 0,
    })
    expect([missing.difference.toFixed(2), missing.status]).toEqual([
      "25.00",
      "UNEXPLAINED_DIFFERENCE",
    ])
    const extra = sessionChipReconciliation({
      delivered: dec(100000),
      returned: dec(100100),
      authorizedUnrecovered: dec(0),
      activeParticipants: 0,
    })
    expect(extra.difference.toFixed(2)).toBe("-100.00")
  })
  it("el motivo de diferencia viaja en la confirmación (lo exige el servidor)", () => {
    expect(
      confirmClosureSchema.safeParse({
        idempotencyKey: "abcdefgh1",
        previewHash: "a".repeat(64),
        differenceReason: "Posible ficha extraviada",
      }).success
    ).toBe(true)
  })
})

describe("permisos y auditoría", () => {
  it("CASHIER confirma el cierre (también con diferencia) y opera rake/propinas; la modalidad la cambia un socio", () => {
    for (const p of [
      PERMISSIONS.SESSIONS_CLOSE_CONFIRM,
      PERMISSIONS.RAKE_OPERATE,
      PERMISSIONS.TIPS_OPERATE,
      PERMISSIONS.STAFF_MANAGE,
    ])
      expect(roleHasPermission("CASHIER", p)).toBe(true)
    expect(roleHasPermission("CASHIER", PERMISSIONS.RAKE_AUTHORIZE)).toBe(false)
    expect(roleHasPermission("PARTNER", PERMISSIONS.RAKE_AUTHORIZE)).toBe(true)
  })
  it("acciones del Módulo 18 en sus módulos", () => {
    expect(moduleOfAction("RAKE_MOVEMENT_CREATED")).toBe("RAKE")
    expect(moduleOfAction("STAFF_TIP_COUNT_CONFIRMED")).toBe("STAFF_TIPS")
    expect(moduleOfAction("SESSION_CLOSED_WITH_DIFFERENCE")).toBe("CLOSURE")
    expect(moduleOfAction("CHIP_DIFFERENCE_RECORDED")).toBe("CLOSURE")
  })
})
