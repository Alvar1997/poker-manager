import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { moduleOfAction } from "@/modules/audit/audit-taxonomy"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import { nextPurchaseNumber } from "@/modules/purchases/purchase.math"
import {
  appearanceSchema,
  assignSeatSchema,
  changeSeatSchema,
  createDealerSchema,
  seatNumberSchema,
  updateDealerSchema,
  withdrawSchema,
} from "@/modules/table-floor/table-floor.schemas"
import {
  contrastRatio,
  DEALER_POSITION,
  DEFAULT_FELT,
  deriveSeatState,
  FELT_COLORS,
  FELT_PALETTE,
  foldAccents,
  initialsOf,
  isFeltColor,
  isValidSeatNumber,
  MIN_FELT_TEXT_CONTRAST,
  QUICK_BUY_AMOUNTS,
  SEAT_COUNT,
  SEAT_LAYOUT,
  SEAT_NUMBERS,
  seatActions,
} from "@/modules/table-floor/table-floor.math"

const KEY = "11111111-2222-3333-4444-555555555555"

/** Cajas reales de las tarjetas (px) por tamaño de pantalla (ver poker-table-felt.tsx). */
const VIEWPORTS = [
  // Celular: ancho − 2×16 de margen; aspecto 10/12 (óvalo vertical).
  { name: "320", w: 288, h: 288 * 1.2, seat: [68, 76], dealer: [100, 60] },
  { name: "360", w: 328, h: 328 * 1.2, seat: [72.2, 76], dealer: [100, 60] },
  { name: "390", w: 358, h: 358 * 1.2, seat: [78.8, 76], dealer: [107.4, 60] },
  { name: "430", w: 398, h: 398 * 1.2, seat: [87.6, 76], dealer: [119.4, 60] },
  // Escritorio: máx. 768 px; aspecto 16/10.
  { name: "768", w: 768, h: 480, seat: [120, 86], dealer: [160, 68] },
  { name: "640", w: 640, h: 400, seat: [120, 86], dealer: [160, 68] },
] as const

function box(
  p: { x: number; y: number },
  size: readonly [number, number],
  v: { w: number; h: number }
) {
  const cx = (p.x / 100) * v.w
  const cy = (p.y / 100) * v.h
  return {
    l: cx - size[0] / 2,
    r: cx + size[0] / 2,
    t: cy - size[1] / 2,
    b: cy + size[1] / 2,
  }
}
/** Separación mínima exigida entre tarjetas (px): que ni siquiera se toquen. */
const GAP = 6
const overlap = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
  a.l < b.r + GAP && b.l < a.r + GAP && a.t < b.b + GAP && b.t < a.b + GAP

describe("nueve asientos", () => {
  it("1. son exactamente nueve, numerados 1..9 y estables", () => {
    expect(SEAT_COUNT).toBe(9)
    expect(SEAT_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(Object.keys(SEAT_LAYOUT).map(Number)).toEqual([...SEAT_NUMBERS])
    expect(isValidSeatNumber(0)).toBe(false)
    expect(isValidSeatNumber(10)).toBe(false)
    expect(isValidSeatNumber(1.5)).toBe(false)
  })

  it("2. distribución alrededor del óvalo: 1-2-3 arriba, 4-5 derecha, 6-7 abajo, 8-9 izquierda", () => {
    const L = SEAT_LAYOUT
    for (const n of [1, 2, 3]) expect(L[n].y).toBeLessThan(15)
    for (const n of [4, 5]) expect(L[n].x).toBeGreaterThan(85)
    for (const n of [6, 7]) expect(L[n].y).toBeGreaterThan(85)
    for (const n of [8, 9]) expect(L[n].x).toBeLessThan(15)
    expect(L[1].x).toBeLessThan(L[2].x)
    expect(L[2].x).toBeLessThan(L[3].x)
    expect(L[4].y).toBeLessThan(L[5].y)
    expect(L[6].x).toBeGreaterThan(L[7].x)
    expect(L[9].y).toBeLessThan(L[8].y)
  })

  it("3. sin superposición entre asientos, ni con el dealer, en celular y escritorio", () => {
    for (const v of VIEWPORTS) {
      const seats = SEAT_NUMBERS.map((n) => box(SEAT_LAYOUT[n], v.seat, v))
      const dealer = box(DEALER_POSITION, v.dealer, v)
      for (let i = 0; i < seats.length; i++) {
        // Dentro del contenedor (sin desbordar la pantalla).
        expect(
          seats[i].l,
          `vp ${v.name} asiento ${i + 1}`
        ).toBeGreaterThanOrEqual(-8)
        expect(seats[i].r, `vp ${v.name} asiento ${i + 1}`).toBeLessThanOrEqual(
          v.w + 8
        )
        expect(
          overlap(seats[i], dealer),
          `vp ${v.name} dealer/asiento ${i + 1}`
        ).toBe(false)
        for (let j = i + 1; j < seats.length; j++)
          expect(
            overlap(seats[i], seats[j]),
            `vp ${v.name} ${i + 1}/${j + 1}`
          ).toBe(false)
      }
    }
  })
})

describe("dealer como persona", () => {
  it("16. está fuera de los nueve asientos, dentro del óvalo y entre los asientos 7 y 6", () => {
    expect(SEAT_NUMBERS).not.toContain(0)
    expect(DEALER_POSITION.x).toBeGreaterThan(SEAT_LAYOUT[7].x)
    expect(DEALER_POSITION.x).toBeLessThan(SEAT_LAYOUT[6].x)
    expect(DEALER_POSITION.x).toBe(50)
    // Dentro del paño (inset vertical 11 %–87 %) y por debajo del centro.
    expect(DEALER_POSITION.y).toBeGreaterThan(55)
    expect(DEALER_POSITION.y).toBeLessThan(87)
    // Por encima de los asientos inferiores (no los toca).
    expect(DEALER_POSITION.y).toBeLessThan(SEAT_LAYOUT[7].y)
  })
})

describe("paño configurable", () => {
  it("20. paleta cerrada con valor por defecto y validación", () => {
    expect(FELT_COLORS).toEqual([
      "CASINO_GREEN",
      "NAVY",
      "WINE",
      "BLACK",
      "GRAPHITE",
      "PURPLE",
    ])
    expect(DEFAULT_FELT).toBe("CASINO_GREEN")
    expect(isFeltColor("NAVY")).toBe(true)
    expect(isFeltColor("#00ff00")).toBe(false)
    expect(appearanceSchema.safeParse({ feltColor: "#00ff00" }).success).toBe(
      false
    )
    expect(appearanceSchema.safeParse({ feltColor: "WINE" }).success).toBe(true)
    expect(
      appearanceSchema.safeParse({ feltColor: "WINE", tableId: "x" }).success
    ).toBe(false)
  })

  it("todo texto sobre el paño tiene contraste AA (≥ 4.5) en cualquier color permitido", () => {
    for (const c of FELT_COLORS) {
      const p = FELT_PALETTE[c]
      expect(contrastRatio(p.text, p.felt), c).toBeGreaterThanOrEqual(
        MIN_FELT_TEXT_CONTRAST
      )
      expect(contrastRatio(p.text, p.feltEdge), c).toBeGreaterThanOrEqual(
        MIN_FELT_TEXT_CONTRAST
      )
    }
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0)
  })
})

describe("estado del asiento y tipo de compra", () => {
  it("5. sentado sin compras = pendiente de compra (sin recompra habilitada, se puede retirar)", () => {
    const s = deriveSeatState({
      chainConfirmedPurchases: 0,
      hasPendingPurchase: false,
      hasSettlementInProgress: false,
    })
    expect(s).toBe("PENDING_BUY")
    expect(seatActions(s)).toMatchObject({
      buy: true,
      settle: false,
      out: false,
      withdraw: true,
      continuePurchase: false,
    })
  })

  it("compra confirmada = jugando (liquidar sí, retirar sin compra no)", () => {
    const s = deriveSeatState({
      chainConfirmedPurchases: 1,
      hasPendingPurchase: false,
      hasSettlementInProgress: false,
    })
    expect(s).toBe("PLAYING")
    expect(seatActions(s)).toMatchObject({
      settle: true,
      out: true,
      withdraw: false,
    })
  })

  it("compra en preparación → continuar (no se inicia otra); liquidación en curso → liquidando", () => {
    const a = deriveSeatState({
      chainConfirmedPurchases: 1,
      hasPendingPurchase: true,
      hasSettlementInProgress: false,
    })
    expect(a).toBe("PURCHASE_IN_PROGRESS")
    expect(seatActions(a)).toMatchObject({
      buy: false,
      continuePurchase: true,
      move: false,
    })
    const b = deriveSeatState({
      chainConfirmedPurchases: 1,
      hasPendingPurchase: false,
      hasSettlementInProgress: true,
    })
    expect(b).toBe("SETTLING")
    expect(seatActions(b)).toMatchObject({
      buy: false,
      settle: true,
      move: false,
    })
  })

  it("6-8. la primera confirmada en la sesión es inicial; las siguientes, recompras numeradas", () => {
    expect(nextPurchaseNumber(null)).toMatchObject({
      purchaseType: "INITIAL_PURCHASE",
      rebuyNumber: null,
    })
    expect(nextPurchaseNumber(1)).toMatchObject({
      purchaseType: "REBUY",
      rebuyNumber: 1,
    })
    expect(nextPurchaseNumber(4)).toMatchObject({
      purchaseType: "REBUY",
      rebuyNumber: 4,
    })
  })

  it("montos rápidos son sugerencias positivas (no límites)", () => {
    expect(QUICK_BUY_AMOUNTS).toEqual([
      "500.00",
      "1000.00",
      "2000.00",
      "3000.00",
      "5000.00",
    ])
  })
})

describe("29. validaciones de entrada (backend)", () => {
  it("asignar asiento: jugador O participación (uno), clave obligatoria, sin campos extra", () => {
    expect(
      assignSeatSchema.safeParse({ playerId: "p1", idempotencyKey: KEY })
        .success
    ).toBe(true)
    expect(
      assignSeatSchema.safeParse({ participationId: "x1", idempotencyKey: KEY })
        .success
    ).toBe(true)
    expect(
      assignSeatSchema.safeParse({
        playerId: "p1",
        participationId: "x1",
        idempotencyKey: KEY,
      }).success
    ).toBe(false)
    expect(assignSeatSchema.safeParse({ idempotencyKey: KEY }).success).toBe(
      false
    )
    expect(assignSeatSchema.safeParse({ playerId: "p1" }).success).toBe(false)
    expect(
      assignSeatSchema.safeParse({
        playerId: "p1",
        idempotencyKey: KEY,
        status: "ACTIVE",
      }).success
    ).toBe(false)
  })

  it("número de asiento 1..9 y cambio de asiento estricto", () => {
    expect(seatNumberSchema.safeParse("9").data).toBe(9)
    for (const bad of ["0", "10", "-1", "2.5", "abc"])
      expect(seatNumberSchema.safeParse(bad).success, bad).toBe(false)
    expect(
      changeSeatSchema.safeParse({
        participationId: "x1",
        toSeat: 4,
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
    expect(
      changeSeatSchema.safeParse({
        participationId: "x1",
        toSeat: 4,
        idempotencyKey: KEY,
        swapWith: 2,
      }).success
    ).toBe(false)
  })

  it("dealer: nombre ≥ 2, sin rol ni credenciales; retiro con motivo", () => {
    expect(createDealerSchema.safeParse({ name: "Ana" }).success).toBe(true)
    expect(createDealerSchema.safeParse({ name: "A" }).success).toBe(false)
    expect(
      createDealerSchema.safeParse({ name: "Ana", role: "CASHIER" }).success
    ).toBe(false)
    expect(
      createDealerSchema.safeParse({ name: "Ana", password: "x" }).success
    ).toBe(false)
    expect(updateDealerSchema.safeParse({}).success).toBe(false)
    expect(updateDealerSchema.safeParse({ isActive: false }).success).toBe(true)
    expect(
      withdrawSchema.safeParse({ reason: "no", idempotencyKey: KEY }).success
    ).toBe(false)
    expect(
      withdrawSchema.safeParse({
        reason: "Se fue sin comprar",
        idempotencyKey: KEY,
      }).success
    ).toBe(true)
  })
})

describe("22/27. permisos y auditoría", () => {
  it("los tres roles operan la mesa con los permisos existentes (sin política nueva)", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.SESSIONS_MANAGE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.PURCHASES_CREATE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.SETTLEMENTS_OPERATE)).toBe(
        true
      )
      expect(roleHasPermission(role, PERMISSIONS.SIGNATURES_CAPTURE)).toBe(true)
    }
  })

  it("los eventos de asientos, dealer y paño se clasifican en Mesas (M07)", () => {
    for (const a of [
      AUDIT_ACTIONS.SEAT_ASSIGNED,
      AUDIT_ACTIONS.SEAT_CHANGED,
      AUDIT_ACTIONS.SEAT_RELEASED,
      AUDIT_ACTIONS.PLAYER_SEATED_PENDING_BUY,
      AUDIT_ACTIONS.TABLE_PARTICIPATION_WITHDRAWN,
      AUDIT_ACTIONS.DEALER_CREATED,
      AUDIT_ACTIONS.DEALER_ASSIGNED,
      AUDIT_ACTIONS.DEALER_CHANGED,
      AUDIT_ACTIONS.DEALER_RELEASED,
      AUDIT_ACTIONS.TABLE_FELT_COLOR_CHANGED,
    ])
      expect(moduleOfAction(a), a).toBe("TABLES")
    // Los jugadores siguen en su módulo.
    expect(moduleOfAction("PLAYER_CREATED")).toBe("PLAYERS")
  })
})

describe("utilidades", () => {
  it("iniciales y búsqueda sin acentos", () => {
    expect(initialsOf("José Peña Ruiz")).toBe("JR")
    expect(initialsOf("ana")).toBe("A")
    expect(initialsOf("  ")).toBe("?")
    expect(foldAccents("JOSÉ PEÑA")).toBe("jose pena")
  })
})
