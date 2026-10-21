// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import ExcelJS from "exceljs"
import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { navigationFor } from "@/config/navigation"
import { Prisma } from "@/generated/prisma/client"
import {
  activeFilters,
  filtersToQuery,
  pageFilters,
  parseReportFilters,
  REPORT_KINDS,
} from "@/modules/reports/report.filters"
import {
  buildCreditTree,
  businessDay,
  businessDayStartUtc,
  businessRange,
  classifyAllocation,
  creditTotals,
  filterTreeByDebtStatus,
  paymentTotals,
  type AllocationFact,
  type DebtFact,
} from "@/modules/reports/report.math"
import {
  cellValue,
  columnLetter,
  excelLocalDate,
  moneyNumber,
  safeText,
  sheetName,
} from "@/modules/reports/xlsx.cells"
import { addKeyValues, addTable } from "@/modules/reports/xlsx.workbook"

const D = (v: string | number) => new Prisma.Decimal(v)

// ── Fixtures: Juan Pérez, sesión A (14 oct) y B (17 oct) ─────────────

const JUAN = { id: "p-juan", name: "Juan Pérez" }
const SESSION_A = {
  id: "s-a",
  folio: "SES-A",
  operatedAt: new Date("2026-10-15T01:00:00Z"), // 14 oct 19:00 Monterrey
  status: "CLOSED",
  closedAt: new Date("2026-10-15T08:00:00Z"),
}
const SESSION_B = {
  id: "s-b",
  folio: "SES-B",
  operatedAt: new Date("2026-10-18T01:00:00Z"), // 17 oct 19:00
  status: "CLOSED",
  closedAt: new Date("2026-10-18T08:00:00Z"),
}

function debt(
  id: string,
  session: DebtFact["session"],
  createdAt: string,
  amount: string,
  over: Partial<DebtFact> = {}
): DebtFact {
  return {
    id,
    createdAt: new Date(createdAt),
    originalAmount: D(amount),
    player: JUAN,
    session,
    table: { id: "t-10", name: "10/10" },
    cycleNumber: 1,
    purchase: {
      id: `pu-${id}`,
      folio: `COM-${id}`,
      type: "INITIAL_PURCHASE",
      rebuyNumber: null,
      nominalAmount: D(amount),
      confirmedAt: new Date(createdAt),
    },
    authorization: {
      partnerId: "u-socio",
      partnerName: "Socio",
      channel: "VERBAL",
    },
    signature: {
      id: `sig-${id}`,
      status: "VALID",
      signedAt: new Date(createdAt),
    },
    ...over,
  }
}

let seq = 0
function alloc(
  receivableId: string,
  amount: string,
  at: string,
  over: Partial<AllocationFact> = {}
): AllocationFact {
  seq += 1
  return {
    id: `al-${String(seq).padStart(3, "0")}`,
    receivableId,
    kind: "APPLICATION",
    source: "RECEIVABLE_PAYMENT",
    amount: D(amount),
    allocatedAt: new Date(at),
    allocationOrder: 1,
    reversesAllocationId: null,
    payment: {
      id: `pay-${seq}`,
      folio: `ABO-${seq}`,
      method: "CASH",
      origin: "ADMINISTRATIVE",
      sessionId: null,
      sessionFolio: null,
      amount: D(amount),
      status: "CONFIRMED",
      paidAt: new Date(at),
    },
    purchasePayment: null,
    settlement: null,
    ...over,
  }
}

// Sesión A: compra inicial $3,000 (10/10) + recompra #1 $2,000 (25/25).
const dA1 = debt("a1", SESSION_A, "2026-10-15T02:00:00Z", "3000")
const dA2 = debt("a2", SESSION_A, "2026-10-15T03:00:00Z", "2000", {
  table: { id: "t-25", name: "25/25" },
  purchase: {
    id: "pu-a2",
    folio: "COM-a2",
    type: "REBUY",
    rebuyNumber: 1,
    nominalAmount: D("2000"),
    confirmedAt: new Date("2026-10-15T03:00:00Z"),
  },
})
// Sesión B: compra $6,000.
const dB1 = debt("b1", SESSION_B, "2026-10-18T02:00:00Z", "6000")

// Abonos previos: $2,000 a la sesión A (compra inicial) y $1,000 a la B.
const prior = [
  alloc("a1", "2000", "2026-10-16T18:00:00Z"),
  alloc("b1", "1000", "2026-10-19T18:00:00Z"),
]
// Abono general de $4,000 el 20 de octubre, distribuido por FIFO:
// a1 $1,000 + a2 $2,000 (sesión A = $3,000) y b1 $1,000.
const fifoPayment = {
  id: "pay-fifo",
  folio: "ABO-FIFO",
  method: "CASH",
  origin: "ADMINISTRATIVE",
  sessionId: null,
  sessionFolio: null,
  amount: D("4000"),
  status: "CONFIRMED",
  paidAt: new Date("2026-10-20T18:00:00Z"),
}
const fifo = [
  alloc("a1", "1000", "2026-10-20T18:00:00Z", {
    payment: fifoPayment,
    allocationOrder: 1,
  }),
  alloc("a2", "2000", "2026-10-20T18:00:00Z", {
    payment: fifoPayment,
    allocationOrder: 2,
  }),
  alloc("b1", "1000", "2026-10-20T18:00:00Z", {
    payment: fifoPayment,
    allocationOrder: 3,
  }),
]

describe("créditos: desglose jugador → sesión → compra", () => {
  it("agrupa por sesión de ORIGEN y totaliza (ejemplo Juan Pérez)", () => {
    const [juan] = buildCreditTree([dB1, dA2, dA1], prior)
    expect(juan.player.name).toBe("Juan Pérez")
    expect(juan.balance).toBe("8000.00")
    expect(juan.original).toBe("11000.00")
    expect(juan.paymentsApplied).toBe("3000.00")
    expect(juan.sessions.map((s) => s.session.folio)).toEqual([
      "SES-A",
      "SES-B",
    ])
    const [a, b] = juan.sessions
    expect([a.original, a.paymentsApplied, a.balance]).toEqual([
      "5000.00",
      "2000.00",
      "3000.00",
    ])
    expect([b.original, b.paymentsApplied, b.balance]).toEqual([
      "6000.00",
      "1000.00",
      "5000.00",
    ])
    expect(juan.sessionsWithBalance).toBe(2)
  })

  it("desglosa cada compra y recompra con su mesa, ciclo y socio originales", () => {
    const [juan] = buildCreditTree([dA1, dA2, dB1], prior)
    const [i, r] = juan.sessions[0].debts
    expect(i.purchase.typeLabel).toBe("Compra inicial")
    expect([i.original, i.paymentsApplied, i.balance, i.status]).toEqual([
      "3000.00",
      "2000.00",
      "1000.00",
      "PARTIALLY_PAID",
    ])
    expect(r.purchase.typeLabel).toBe("Recompra #1")
    expect(r.table.name).toBe("25/25")
    expect([r.original, r.paymentsApplied, r.balance, r.status]).toEqual([
      "2000.00",
      "0.00",
      "2000.00",
      "OPEN",
    ])
    expect(i.authorization.partnerName).toBe("Socio")
    expect(i.signature?.status).toBe("VALID")
  })

  it("FIFO entre sesiones: el abono del 20 no traslada la deuda a otra sesión", () => {
    const [juan] = buildCreditTree([dA1, dA2, dB1], [...prior, ...fifo])
    const [a, b] = juan.sessions
    expect(a.balance).toBe("0.00")
    expect(b.balance).toBe("4000.00")
    expect(juan.balance).toBe("4000.00")
    // Ninguna sesión nueva aparece por el abono.
    expect(juan.sessions).toHaveLength(2)
    // La aplicación conserva la FECHA REAL del abono, distinta del origen.
    const app = a.debts[1].applications[0]
    expect(app.appliedAt).toBe("2026-10-20T18:00:00.000Z")
    expect(a.debts[1].createdAt).toBe("2026-10-15T03:00:00.000Z")
    expect(app.paymentTotal).toBe("4000.00")
  })

  it("un abono repartido en varias obligaciones suma una vez en totales", () => {
    const t = paymentTotals([
      {
        id: "pay-fifo",
        amount: D("4000"),
        status: "CONFIRMED",
        unapplied: D(0),
        allocations: fifo.map((a) => ({ kind: a.kind, amount: a.amount })),
      },
    ])
    expect(t.received).toBe("4000.00")
    expect(t.appliedNet).toBe("4000.00")
    expect(t.confirmedCount).toBe(1)
  })

  it("pago vinculado a la compra se clasifica aparte (no FIFO)", () => {
    const linked = alloc("b1", "500", "2026-10-21T18:00:00Z", {
      source: "PURCHASE_PAYMENT",
      payment: null,
      purchasePayment: { id: "pp1", method: "BANK_TRANSFER" },
    })
    expect(classifyAllocation(linked)).toBe("LINKED_PAYMENT")
    const [juan] = buildCreditTree([dB1], [linked])
    const d = juan.sessions[0].debts[0]
    expect(d.linkedPayments).toBe("500.00")
    expect(d.payments).toBe("0.00")
    expect(d.balance).toBe("5500.00")
    expect(d.applications[0].paymentMethod).toBe("BANK_TRANSFER")
  })

  it("deuda al cierre vs. actual: el histórico no cambia con abonos posteriores", () => {
    // a1 recibió $2,000 ANTES del cierre de A (dentro de la sesión).
    const inSession = alloc("a1", "2000", "2026-10-15T05:00:00Z")
    const later = alloc("a1", "500", "2026-10-22T18:00:00Z")
    const [before] = buildCreditTree([dA1, dA2], [inSession])
    const [after] = buildCreditTree([dA1, dA2], [inSession, later])
    expect(before.sessions[0].atClosure?.balanceAtClosure).toBe("3000.00")
    expect(after.sessions[0].atClosure?.balanceAtClosure).toBe("3000.00")
    expect(after.sessions[0].atClosure?.paymentsAfter).toBe("500.00")
    expect(after.sessions[0].atClosure?.currentBalance).toBe("2500.00")
    expect(after.sessions[0].atClosure?.reconciles).toBe(true)
  })

  it("abonos posteriores al cierre, compensaciones y reversos se identifican por separado", () => {
    const offset = alloc("a1", "300", "2026-10-25T18:00:00Z", {
      source: "CHIP_SETTLEMENT_OFFSET",
      payment: null,
      settlement: { id: "st1", folio: "LIQ-1", sessionId: "s-c" },
    })
    const pay = alloc("a1", "1000", "2026-10-23T18:00:00Z")
    const reversal = alloc("a1", "1000", "2026-10-24T18:00:00Z", {
      kind: "REVERSAL",
      reversesAllocationId: pay.id,
    })
    const [juan] = buildCreditTree([dA1], [pay, reversal, offset])
    const c = juan.sessions[0].atClosure!
    expect(c.balanceAtClosure).toBe("3000.00")
    expect(c.paymentsAfter).toBe("1000.00")
    expect(c.reversalsAfter).toBe("1000.00")
    expect(c.offsetsAfter).toBe("300.00")
    expect(c.currentBalance).toBe("2700.00")
    expect(c.reconciles).toBe(true)
    expect(juan.offsets).toBe("300.00")
    expect(juan.reversals).toBe("1000.00")
  })

  it("compensación en liquidación no es abono de efectivo y deuda no compensada permanece", () => {
    const offset = alloc("b1", "1000", "2026-10-18T05:00:00Z", {
      source: "CHIP_SETTLEMENT_OFFSET",
      payment: null,
      settlement: { id: "st2", folio: "LIQ-2", sessionId: "s-b" },
    })
    const [juan] = buildCreditTree([dB1, dA1], [offset])
    expect(juan.payments).toBe("0.00")
    expect(juan.paymentsApplied).toBe("0.00")
    expect(juan.offsets).toBe("1000.00")
    // La deuda de A, no compensada, sigue intacta.
    expect(juan.sessions[0].balance).toBe("3000.00")
  })

  it("sesión abierta no tiene deuda histórica al cierre", () => {
    const open = { ...SESSION_B, status: "OPEN", closedAt: null }
    const [juan] = buildCreditTree(
      [debt("x", open, "2026-10-18T02:00:00Z", "100")],
      []
    )
    expect(juan.sessions[0].atClosure).toBeNull()
  })

  it("orden: deudas más antiguas primero y totales globales sin duplicar", () => {
    const ana = { id: "p-ana", name: "Ana" }
    const anaDebt = debt("z", SESSION_B, "2026-10-18T04:00:00Z", "700", {
      player: ana,
    })
    const tree = buildCreditTree([anaDebt, dA1, dB1], [])
    expect(tree.map((p) => p.player.name)).toEqual(["Juan Pérez", "Ana"])
    const t = creditTotals(tree)
    expect(t.balance).toBe("9700.00")
    expect(t.playersWithBalance).toBe(2)
  })

  it("filtro por estado derivado recalcula totales", () => {
    const tree = buildCreditTree([dA1, dA2, dB1], prior)
    const open = filterTreeByDebtStatus(tree, "OPEN")
    expect(open[0].sessions.map((s) => s.session.folio)).toEqual(["SES-A"])
    expect(open[0].balance).toBe("2000.00")
    const paid = filterTreeByDebtStatus(
      buildCreditTree([dA1, dA2, dB1], [...prior, ...fifo]),
      "PAID"
    )
    expect(paid[0].sessions[0].debts.map((d) => d.purchase.folio)).toEqual([
      "COM-a1",
      "COM-a2",
    ])
  })
})

describe("fechas operativas (America/Monterrey)", () => {
  it("convierte días operativos a instantes UTC", () => {
    expect(businessDayStartUtc("2026-10-14").toISOString()).toBe(
      "2026-10-14T06:00:00.000Z"
    )
    const r = businessRange("2026-10-14", "2026-10-14")!
    expect(r.gte?.toISOString()).toBe("2026-10-14T06:00:00.000Z")
    expect(r.lt?.toISOString()).toBe("2026-10-15T06:00:00.000Z")
    expect(businessRange()).toBeUndefined()
  })

  it("una sesión que cruza medianoche conserva su día de apertura", () => {
    expect(businessDay(new Date("2026-10-15T05:30:00Z"))).toBe("2026-10-14")
  })
})

describe("filtros de reportes", () => {
  it("valida fechas, identificadores y rango", () => {
    expect(parseReportFilters("credits", { debtFrom: "2026-13-01" }).ok).toBe(
      false
    )
    expect(parseReportFilters("credits", { playerId: "x'; DROP" }).ok).toBe(
      false
    )
    const bad = parseReportFilters("credits", {
      debtFrom: "2026-10-20",
      debtTo: "2026-10-01",
    })
    expect(bad.ok).toBe(false)
    const ok = parseReportFilters("credits", {
      debtFrom: "2026-10-01",
      sessionId: "",
      page: "2",
    })
    expect(ok.ok && ok.filters.page).toBe(2)
    expect(ok.ok && ok.filters.sessionId).toBeUndefined()
  })

  it("el estado debe pertenecer al reporte", () => {
    expect(parseReportFilters("credits", { status: "PAID" }).ok).toBe(true)
    expect(parseReportFilters("credits", { status: "CONFIRMED" }).ok).toBe(
      false
    )
    expect(parseReportFilters("purchases", { status: "CONFIRMED" }).ok).toBe(
      true
    )
  })

  it("limita el tamaño de página y usa valores por defecto ante errores", () => {
    expect(parseReportFilters("sessions", { pageSize: "1000" }).ok).toBe(false)
    const p = pageFilters("sessions", { from: "nope" })
    expect(p.issues.length).toBeGreaterThan(0)
    expect(p.filters.page).toBe(1)
  })

  it("serializa filtros para persistirlos en la URL", () => {
    expect(filtersToQuery({ page: 1, pageSize: 25, playerId: "p1" })).toBe(
      "?playerId=p1"
    )
    expect(filtersToQuery({ page: 1, pageSize: 25 }, { page: 3 })).toBe(
      "?page=3"
    )
    const r = parseReportFilters("credits", {
      playerId: "p1",
      debtFrom: "2026-10-01",
    })
    expect(r.ok && activeFilters(r.filters).map((a) => a.key)).toEqual([
      "playerId",
      "debtFrom",
    ])
  })

  it("distingue fecha de origen de deuda y fecha de abono", () => {
    const r = parseReportFilters("payments", {
      debtFrom: "2026-10-14",
      paymentFrom: "2026-10-20",
    })
    expect(r.ok && [r.filters.debtFrom, r.filters.paymentFrom]).toEqual([
      "2026-10-14",
      "2026-10-20",
    ])
  })
})

describe("XLSX: celdas seguras", () => {
  it("previene inyección de fórmulas en textos de usuario", () => {
    expect(safeText('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")')
    expect(safeText("+1")).toBe("'+1")
    expect(safeText("-SUM(A1)")).toBe("'-SUM(A1)")
    expect(safeText("@cmd")).toBe("'@cmd")
    expect(safeText("\tx")).toBe("'\tx")
    expect(safeText("Juan\u0000 Pérez")).toBe("Juan Pérez")
    expect(safeText("Juan Pérez")).toBe("Juan Pérez")
  })

  it("conserva importes numéricos con dos decimales", () => {
    expect(moneyNumber("4000.00")).toBe(4000)
    expect(moneyNumber("1234.56")).toBe(1234.56)
    expect(moneyNumber("-0.10")).toBe(-0.1)
    expect(moneyNumber("=1+1")).toBeNull()
    expect(cellValue("money", "3000.00")).toBe(3000)
    expect(cellValue("int", "7")).toBe(7)
  })

  it("escribe la hora local del negocio y nombres de hoja válidos", () => {
    expect(excelLocalDate("2026-10-20T18:00:00Z")?.toISOString()).toBe(
      "2026-10-20T12:00:00.000Z"
    )
    expect(columnLetter(1)).toBe("A")
    expect(columnLetter(28)).toBe("AB")
    expect(sheetName("Deudas/por:sesión [x]")).toBe("Deudas por sesión  x ")
  })

  it("genera un libro legible: números reales, formato MXN, totales y sin fórmulas de usuario", async () => {
    const wb = new ExcelJS.Workbook()
    type R = { name: string; amount: string }
    addTable<R>(
      wb,
      "Detalle",
      [
        { header: "Jugador", type: "text", value: (r) => r.name },
        {
          header: "Importe",
          type: "money",
          value: (r) => r.amount,
          total: "4000.00",
        },
      ],
      [
        { name: "=CMD()", amount: "3000.00" },
        { name: "Ana", amount: "1000.00" },
      ]
    )
    addKeyValues(wb, "Resumen", [{ label: "Deuda", value: "4000.00" }])
    const buf = await wb.xlsx.writeBuffer()
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(buf as ArrayBuffer)
    const ws = back.getWorksheet("Detalle")!
    expect(ws.getCell("A1").value).toBe("Jugador")
    expect(ws.getCell("A2").value).toBe("'=CMD()")
    expect(ws.getCell("B2").value).toBe(3000)
    expect(ws.getCell("B2").numFmt).toContain("#,##0.00")
    const total = ws.getCell("B4").value as { formula: string; result: number }
    expect(total.formula).toBe("SUM(B2:B3)")
    expect(total.result).toBe(4000)
    // Ninguna celda de datos es fórmula.
    for (const addr of ["A2", "A3", "B2", "B3"])
      expect(typeof ws.getCell(addr).value).not.toBe("object")
    expect(back.getWorksheet("Resumen")!.getCell("B2").value).toBe(4000)
  })
})

describe("reportes: permisos y formatos", () => {
  it("los tres roles consultan reportes operativos y financieros y exportan", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_VIEW)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_FINANCIAL)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_EXPORT)).toBe(true)
      expect(navigationFor(role).map((i) => i.id)).toContain("reports")
    }
  })

  it("los reportes no editan datos: solo rutas GET", () => {
    const dir = join(process.cwd(), "src/app/api/reports")
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (f === "route.ts") files.push(p)
      }
    }
    walk(dir)
    expect(files.length).toBeGreaterThanOrEqual(17)
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src).toMatch(/export const GET/)
      expect(src).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/)
    }
  })

  it("sin CSV ni PDF: el módulo solo produce XLSX", () => {
    const dir = join(process.cwd(), "src/modules/reports")
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n")
    expect(sources).not.toMatch(/text\/csv/)
    expect(sources).not.toMatch(/application\/pdf/)
    expect(sources).not.toMatch(/\.csv["'`]/)
    expect(sources).not.toMatch(/\.pdf["'`]/)
    expect(sources).toMatch(/spreadsheetml\.sheet/)
    expect(REPORT_KINDS).toContain("credits")
  })
})
