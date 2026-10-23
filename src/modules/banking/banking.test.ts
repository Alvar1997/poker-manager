import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { moduleOfAction } from "@/modules/audit/audit-taxonomy"

import {
  advanceLimit,
  buildTranches,
  canonicalJson,
  checkReconciliation,
  computeCycle,
  confirmedDeficit,
  dec,
  disbursementStatus,
  distributeRecovery,
  fmt,
  grossResult,
  guaranteedPlayerShare,
  parsePercentages,
  reserveBalance,
  segmentForGame,
  splitShare,
  validateAllocation,
  validateDistribution,
  withdrawableReserve,
  type GameFact,
} from "./banking.math"
import {
  approveClosingSchema,
  createAdvanceSchema,
  createAgreementSchema,
  disburseSchema,
  prepareClosingSchema,
  reconcileSchema,
} from "./banking.schemas"

const ZERO = dec(0)
const g = (n: number, result: string, pct = "50", seg = "s1"): GameFact => ({
  gameNumber: n,
  result: dec(result),
  segmentId: seg,
  playerPercent: dec(pct),
})
const base = {
  previousCarriedLoss: ZERO,
  reserveAvailable: ZERO,
  advancesPaid: ZERO,
  pendingRecovery: ZERO,
}

describe("porcentajes y reparto", () => {
  it("valida 0–100 con hasta 2 decimales y casa = 100 − jugador", () => {
    expect(fmt(parsePercentages("50").house)).toBe("50.00")
    expect(fmt(parsePercentages("62.5").house)).toBe("37.50")
    expect(() => parsePercentages("101")).toThrow()
    expect(() => parsePercentages("-1")).toThrow()
    expect(() => parsePercentages("50.555")).toThrow()
  })

  it("redondeo explícito: la suma del reparto es EXACTAMENTE lo repartible", () => {
    const s = splitShare(dec("100.01"), dec("33.33"))
    expect(s.player.add(s.house).toFixed(2)).toBe("100.01")
    expect(fmt(s.player)).toBe("33.33")
    expect(fmt(splitShare(dec("0.05"), dec("50"), "DOWN").player)).toBe("0.02")
    expect(fmt(splitShare(dec("0.05"), dec("50")).player)).toBe("0.03")
  })
})

describe("resultado de cada jugada", () => {
  it("devuelto − financiado: +3,000 / −3,000 / −7,000 con retorno cero", () => {
    expect(fmt(grossResult(dec("10000"), dec("7000")))).toBe("3000.00")
    expect(fmt(grossResult(dec("4000"), dec("7000")))).toBe("-3000.00")
    expect(fmt(grossResult(dec("0"), dec("7000")))).toBe("-7000.00")
    expect(() => grossResult(dec("-1"), dec("10"))).toThrow()
    expect(() => grossResult(dec("10"), dec("0"))).toThrow()
  })

  it("conciliación: el retorno cero exige confirmación expresa; sin compras pendientes", () => {
    const ok = {
      financed: dec("1000"),
      pendingPurchases: 0,
      returned: dec("0"),
      zeroReturnConfirmed: true,
      circulation: dec("5000"),
    }
    expect(checkReconciliation(ok)).toMatchObject({ ok: true })
    expect(checkReconciliation({ ...ok, zeroReturnConfirmed: false })).toEqual({
      ok: false,
      reason: "ZERO_NOT_CONFIRMED",
    })
    expect(checkReconciliation({ ...ok, pendingPurchases: 1 })).toMatchObject({
      reason: "PENDING_PURCHASE",
    })
    expect(checkReconciliation({ ...ok, financed: ZERO })).toMatchObject({
      reason: "NO_FINANCED_PURCHASES",
    })
    expect(
      checkReconciliation({
        ...ok,
        returned: dec("6000"),
        zeroReturnConfirmed: false,
      })
    ).toMatchObject({ reason: "EXCEEDS_CIRCULATION" })
    expect(checkReconciliation({ ...ok, returned: dec("10") })).toMatchObject({
      reason: "ZERO_FLAG_WITH_CHIPS",
    })
  })
})

describe("tramos", () => {
  const segs = [
    {
      id: "a",
      fromGameNumber: 1,
      playerPercent: dec("50"),
      createdAt: new Date(1),
    },
    {
      id: "b",
      fromGameNumber: 3,
      playerPercent: dec("60"),
      createdAt: new Date(2),
    },
  ]
  it("«desde la siguiente jugada»: las anteriores conservan su tramo", () => {
    expect(segmentForGame(segs, 1).id).toBe("a")
    expect(segmentForGame(segs, 2).id).toBe("a")
    expect(segmentForGame(segs, 3).id).toBe("b")
    expect(segmentForGame(segs, 4).id).toBe("b")
  })
  it("«todo el ciclo»: un tramo nuevo desde la jugada 1 rige todas", () => {
    const whole = [
      ...segs,
      {
        id: "c",
        fromGameNumber: 1,
        playerPercent: dec("40"),
        createdAt: new Date(3),
      },
    ]
    for (const n of [1, 2, 3, 4]) expect(segmentForGame(whole, n).id).toBe("c")
  })
  it("agrupa ganancias y pérdidas por tramo sin alterar resultados", () => {
    const t = buildTranches([
      g(1, "4000", "50", "a"),
      g(2, "-1000", "50", "a"),
      g(3, "3000", "60", "b"),
    ])
    expect(t.map((x) => [x.key, fmt(x.gains), fmt(x.losses)])).toEqual([
      ["a", "4000.00", "1000.00"],
      ["b", "3000.00", "0.00"],
    ])
  })
})

describe("corte: compensación, reserva y arrastre", () => {
  it("Escenario A: +5,000 −2,000 +4,000 −1,000 al 50% → 3,000; − anticipo 1,000 = 2,000", () => {
    const r = computeCycle({
      ...base,
      games: [g(1, "5000"), g(2, "-2000"), g(3, "4000"), g(4, "-1000")],
      advancesPaid: dec("1000"),
    })
    expect(fmt(r.grossTotal)).toBe("6000.00")
    expect(fmt(r.coveredByGains)).toBe("3000.00")
    expect(fmt(r.playerShare)).toBe("3000.00")
    expect(fmt(r.houseShare)).toBe("3000.00")
    expect(fmt(r.balance)).toBe("2000.00")
    expect(fmt(r.excessAdvance)).toBe("0.00")
    expect(validateDistribution(r, dec("1500"), dec("500"))).toEqual([])
    expect(validateDistribution(r, dec("1500"), dec("600"))).toHaveLength(1)
    expect(validateDistribution(r, dec("-1"), dec("2001"))).not.toEqual([])
  })

  it("Escenario B: reserva 3,000 cubre −5,000 → arrastre 2,000 (lo cubierto no se vuelve a aplicar)", () => {
    const r = computeCycle({
      ...base,
      games: [g(1, "-2000"), g(2, "-1000"), g(3, "-1000"), g(4, "-1000")],
      reserveAvailable: dec("3000"),
    })
    expect(fmt(r.deficit)).toBe("5000.00")
    expect(fmt(r.reserveConsumed)).toBe("3000.00")
    expect(fmt(r.carriedLossOut)).toBe("2000.00")
    expect(fmt(r.playerShare)).toBe("0.00")
    // El siguiente ciclo recupera SOLO el arrastre.
    const next = computeCycle({
      ...base,
      games: [g(1, "3000"), g(2, "0"), g(3, "0"), g(4, "0")],
      previousCarriedLoss: r.carriedLossOut,
    })
    expect(fmt(next.eligibleTotal)).toBe("1000.00")
    expect(fmt(next.playerShare)).toBe("500.00")
    expect(fmt(next.reserveConsumed)).toBe("0.00")
  })

  it("reserva insuficiente parcial y sin reserva: arrastre exacto", () => {
    const r = computeCycle({
      ...base,
      games: [g(1, "-500"), g(2, "200"), g(3, "0"), g(4, "0")],
    })
    expect(fmt(r.carriedLossOut)).toBe("300.00")
    expect(fmt(r.coveredByGains)).toBe("200.00")
  })

  it("Escenario C: pérdidas entre tramos → decisión obligatoria y validada", () => {
    const games = [
      g(1, "4000", "50", "A"),
      g(2, "-1000", "50", "A"),
      g(3, "3000", "60", "B"),
      g(4, "-2000", "60", "B"),
    ]
    const pending = computeCycle({ ...base, games })
    expect(pending.allocationRequired).toBe(true)
    expect(pending.allocationErrors).toHaveLength(1)
    const tranches = buildTranches(games)
    expect(
      validateAllocation(tranches, dec("3000"), { A: "1000", B: "2000" })
    ).toEqual([])
    expect(
      validateAllocation(tranches, dec("3000"), { A: "4000" }).join()
    ).toMatch(/exactamente/)
    expect(
      validateAllocation(tranches, dec("3000"), { A: "0", B: "3500" }).join()
    ).toMatch(/solo tiene/)
    expect(
      validateAllocation(tranches, dec("3000"), { Z: "3000" }).join()
    ).toMatch(/no pertenece/)
    const ok = computeCycle({
      ...base,
      games,
      allocation: { A: "1000", B: "2000" },
    })
    expect(ok.allocationErrors).toEqual([])
    expect(fmt(ok.playerShare)).toBe("2100.00")
    expect(fmt(ok.houseShare)).toBe("1900.00")
    expect(fmt(ok.playerShare.add(ok.houseShare))).toBe(fmt(ok.eligibleTotal))
    // Otra distribución válida da otro reparto, pero el bruto es el mismo.
    const other = computeCycle({
      ...base,
      games,
      allocation: { A: "3000", B: "0" },
    })
    expect(fmt(other.playerShare)).toBe("2300.00")
    expect(fmt(other.grossTotal)).toBe(fmt(ok.grossTotal))
  })

  it("sin decisión cuando todos los tramos con ganancia tienen el mismo porcentaje", () => {
    const r = computeCycle({
      ...base,
      games: [
        g(1, "1000", "50", "A"),
        g(2, "-500", "50", "A"),
        g(3, "1000", "50", "B"),
      ],
    })
    expect(r.allocationRequired).toBe(false)
    expect(fmt(r.playerShare)).toBe("750.00")
  })

  it("Escenario E: anticipos 3,000 > participación 2,000 → excedente 1,000, sin saldo que repartir", () => {
    const r = computeCycle({
      ...base,
      games: [g(1, "6000"), g(2, "-2000"), g(3, "0"), g(4, "0")],
      advancesPaid: dec("3000"),
    })
    expect(fmt(r.excessAdvance)).toBe("1000.00")
    expect(fmt(r.balance)).toBe("0.00")
    expect(validateDistribution(r, ZERO, ZERO)).toEqual([])
    expect(validateDistribution(r, dec("1"), ZERO)).toHaveLength(1)
  })

  it("recuperación de excedentes previos antes de reconocer pago (FIFO)", () => {
    const r = computeCycle({
      ...base,
      games: [g(1, "4000"), g(2, "0"), g(3, "0"), g(4, "0")],
      pendingRecovery: dec("1500"),
    })
    expect(fmt(r.recoveryApplied)).toBe("1500.00")
    expect(fmt(r.balance)).toBe("500.00")
    expect(
      distributeRecovery(dec("1500"), [
        { id: "x", remaining: dec("1000") },
        { id: "y", remaining: dec("800") },
      ]).map((d) => [d.id, fmt(d.amount)])
    ).toEqual([
      ["x", "1000.00"],
      ["y", "500.00"],
    ])
  })
})

describe("límite conservador de anticipos", () => {
  const ok = {
    cycleOpen: true,
    previousCyclesClosed: true,
    unsettledGames: false,
    openRegularization: false,
    previousCarriedLoss: ZERO,
    committedAdvances: ZERO,
    pendingRecovery: ZERO,
  }
  it("Escenario D: jugada ganadora +4,000 al 50% → 2,000; comprometido 1,000 → 1,000", () => {
    expect(fmt(advanceLimit({ ...ok, games: [g(1, "4000")] }).available)).toBe(
      "2000.00"
    )
    expect(
      fmt(
        advanceLimit({
          ...ok,
          games: [g(1, "4000")],
          committedAdvances: dec("1000"),
        }).available
      )
    ).toBe("1000.00")
  })
  it("con varios tramos usa el MÍNIMO garantizado (absorbe en el de mayor %) y un centavo de margen", () => {
    const games = [
      g(1, "4000", "50", "A"),
      g(2, "-1000", "50", "A"),
      g(3, "3000", "60", "B"),
      g(4, "-2000", "60", "B"),
    ]
    // Mínimo: B absorbe 3,000 → 0 al 60%; A 4,000 al 50% = 2,000 (1 tramo activo).
    expect(
      fmt(guaranteedPlayerShare({ games, previousCarriedLoss: ZERO }))
    ).toBe("2000.00")
    // Ninguna distribución válida da menos.
    for (const a of ["0", "1000", "2000", "3000"]) {
      const b = dec("3000").sub(dec(a)).toFixed(2)
      if (dec(b).greaterThan(3000)) continue
      const r = computeCycle({ ...base, games, allocation: { A: a, B: b } })
      expect(r.playerShare.greaterThanOrEqualTo(dec("2000"))).toBe(true)
    }
  })
  it("cero si no puede demostrarse: pérdidas, ciclos previos abiertos, jugadas sin conciliar, regularización o 4/4", () => {
    expect(fmt(advanceLimit({ ...ok, games: [g(1, "-100")] }).available)).toBe(
      "0.00"
    )
    for (const flag of [
      { previousCyclesClosed: false },
      { unsettledGames: true },
      { openRegularization: true },
      { cycleOpen: false },
    ]) {
      const l = advanceLimit({ ...ok, ...flag, games: [g(1, "4000")] })
      expect(fmt(l.available)).toBe("0.00")
      expect(l.blockedReason).toBeTruthy()
    }
    expect(
      fmt(
        advanceLimit({
          ...ok,
          games: [g(1, "4000")],
          previousCarriedLoss: dec("4000"),
        }).available
      )
    ).toBe("0.00")
  })
})

describe("reserva", () => {
  it("saldo derivado del libro y retirable menos el déficit confirmado", () => {
    const bal = reserveBalance([
      { kind: "CREATED", amount: dec("5000") },
      { kind: "RECLASSIFIED_TO_WITHDRAWAL", amount: dec("2000") },
      { kind: "RELEASED_FROM_WITHDRAWAL", amount: dec("1000") },
      { kind: "CONSUMED_BY_LOSS", amount: dec("500") },
    ])
    expect(fmt(bal)).toBe("3500.00")
    expect(
      fmt(
        withdrawableReserve({ balance: bal, currentCycleDeficit: dec("1000") })
      )
    ).toBe("2500.00")
    expect(
      fmt(
        withdrawableReserve({ balance: bal, currentCycleDeficit: dec("9000") })
      )
    ).toBe("0.00")
    expect(
      fmt(
        confirmedDeficit({
          games: [g(1, "-2000"), g(2, "500")],
          previousCarriedLoss: dec("100"),
        })
      )
    ).toBe("1600.00")
  })
  it("estado de pagos: parcial, pagado y cerrado", () => {
    expect(disbursementStatus(dec("1000"), ZERO, false)).toBe("AUTHORIZED")
    expect(disbursementStatus(dec("1000"), dec("600"), false)).toBe(
      "PARTIALLY_PAID"
    )
    expect(disbursementStatus(dec("1000"), dec("1000"), false)).toBe("PAID")
    expect(disbursementStatus(dec("1000"), dec("600"), true)).toBe("CLOSED")
  })
  it("JSON canónico estable para la huella del corte", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe(
      canonicalJson({ a: [2, { c: 0, d: 1 }], b: 1 })
    )
  })
})

describe("permisos, schemas y auditoría privada", () => {
  it("CASHIER opera y consulta; solo PARTNER/SUPERADMIN aprueban digitalmente", () => {
    expect(roleHasPermission("CASHIER", PERMISSIONS.BANKING_READ)).toBe(true)
    expect(roleHasPermission("CASHIER", PERMISSIONS.BANKING_OPERATE)).toBe(true)
    expect(roleHasPermission("CASHIER", PERMISSIONS.BANKING_APPROVE)).toBe(
      false
    )
    for (const r of ["PARTNER", "SUPERADMIN"] as const)
      expect(roleHasPermission(r, PERMISSIONS.BANKING_APPROVE)).toBe(true)
  })
  it("el cliente nunca envía resultados, aprobadores ni saldos", () => {
    const k = "k-12345678"
    expect(
      createAgreementSchema.safeParse({
        playerId: "p1",
        playerPercent: "50",
        reason: "Acuerdo privado de prueba",
        approvedById: "u1",
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      reconcileSchema.safeParse({
        returnedNominalAmount: "0",
        zeroReturnConfirmed: true,
        physicalReturnVerified: true,
        expectedVersion: 1,
        grossResult: "-100",
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      reconcileSchema.safeParse({
        returnedNominalAmount: "10",
        zeroReturnConfirmed: false,
        physicalReturnVerified: false,
        expectedVersion: 1,
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      createAdvanceSchema.safeParse({
        playerId: "p1",
        enablingGameId: "g1",
        requestedAmount: "100",
        authorizedAmount: "100",
        authorizerId: "u1",
        channel: "DIGITAL",
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      disburseSchema.safeParse({
        amount: "100",
        method: "BANK_TRANSFER",
        funding: "SESSION_CASH",
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      prepareClosingSchema.safeParse({
        reserveAmount: "-1",
        payAmount: "0",
        idempotencyKey: k,
      }).success
    ).toBe(false)
    expect(
      approveClosingSchema.safeParse({
        closingId: "c1",
        snapshotHash: "no-es-una-huella",
        idempotencyKey: k,
      }).success
    ).toBe(false)
  })
  it("los eventos BANKING_* pertenecen al módulo privado", () => {
    for (const a of [
      "BANKING_AGREEMENT_CREATED",
      "BANKING_GAME_CONFIRMED",
      "BANKING_CLOSING_APPROVED",
      "BANKING_RESERVE_WITHDRAWAL_PAID",
    ])
      expect(moduleOfAction(a)).toBe("BANKING")
  })
})
