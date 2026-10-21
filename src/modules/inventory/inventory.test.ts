import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import {
  activeInventory,
  adjustmentDelta,
  availableQuantity,
  countDifference,
  nominalValue,
  requestHash,
  sumDecimals,
} from "@/modules/inventory/inventory.math"
import {
  adjustmentSchema,
  createCountSchema,
  initialStockSchema,
  reconcileCountSchema,
  stockEntrySchema,
  stockWithdrawalSchema,
  updateCountSchema,
} from "@/modules/inventory/inventory.schemas"

const key = "8f1c2d3e-4b5a-6789-abcd-ef0123456789"
const line = (quantity: unknown, denominationId = "den25") => ({
  denominationId,
  quantity,
})

describe("identidad del inventario (juego, denominación, maletín)", () => {
  it("toda operación identifica el juego y cada denominación", () => {
    expect(
      stockEntrySchema.safeParse({
        lines: [line(1)],
        reason: "Repo",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "set25",
        lines: [{ quantity: 1 }],
        reason: "Repo",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      adjustmentSchema.safeParse({
        chipSetId: "set25",
        kind: "SURPLUS",
        quantity: 1,
        reason: "Sobra",
        idempotencyKey: key,
      }).success
    ).toBe(false)
  })

  it("una denominación aparece una sola vez por operación", () => {
    const res = stockEntrySchema.safeParse({
      chipSetId: "set25",
      lines: [line(1), line(2)],
      reason: "Repo",
      idempotencyKey: key,
    })
    expect(res.success).toBe(false)
  })

  it("el maletín no se elige por el cliente: no se aceptan campos de contenedor ni saldos", () => {
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "set25",
        containerId: "otro",
        lines: [line(1)],
        reason: "Repo",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "set25",
        lines: [line(1)],
        reason: "Repo",
        idempotencyKey: key,
        balance: 9,
      }).success
    ).toBe(false)
  })
})

describe("cantidades enteras", () => {
  it.each([-1, 1.5, 0.1, "3", null, Number.NaN])(
    "rechaza %p en entradas",
    (q) => {
      expect(
        stockEntrySchema.safeParse({
          chipSetId: "set25",
          lines: [line(q)],
          reason: "Repo",
          idempotencyKey: key,
        }).success
      ).toBe(false)
    }
  )

  it("las entradas exigen > 0; el inventario inicial acepta 0", () => {
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "set25",
        lines: [line(0)],
        reason: "Repo",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      initialStockSchema.safeParse({
        chipSetId: "set25",
        lines: [line(0)],
        idempotencyKey: key,
      }).success
    ).toBe(true)
    expect(
      initialStockSchema.safeParse({
        chipSetId: "set25",
        lines: [line(-1)],
        idempotencyKey: key,
      }).success
    ).toBe(false)
  })

  it("el conteo acepta enteros ≥ 0 o null (sin capturar)", () => {
    expect(
      updateCountSchema.safeParse({
        lines: [{ denominationId: "d", countedQuantity: 0 }],
      }).success
    ).toBe(true)
    expect(
      updateCountSchema.safeParse({
        lines: [{ denominationId: "d", countedQuantity: null }],
      }).success
    ).toBe(true)
    expect(
      updateCountSchema.safeParse({
        lines: [{ denominationId: "d", countedQuantity: 2.5 }],
      }).success
    ).toBe(false)
  })
})

describe("valor nominal (Decimal, no Float; no es efectivo)", () => {
  it("multiplica cantidad × valor exactos", () => {
    expect(nominalValue(3, "0.10").toFixed(2)).toBe("0.30") // con Float sería 0.30000000000000004
    expect(nominalValue(98, "100").toFixed(2)).toBe("9800.00")
    expect(
      sumDecimals([nominalValue(2, "25"), nominalValue(1, "0.5")]).toFixed(2)
    ).toBe("50.50")
    expect(() => nominalValue(1.5, "25")).toThrow()
  })
})

describe("inventario inicial, entradas, bajas y ajustes (validación)", () => {
  it("entradas, bajas y ajustes exigen motivo", () => {
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "s",
        lines: [line(1)],
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      stockWithdrawalSchema.safeParse({
        chipSetId: "s",
        category: "DAMAGE",
        lines: [line(1)],
        reason: " ",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      adjustmentSchema.safeParse({
        chipSetId: "s",
        denominationId: "d",
        kind: "SHORTAGE",
        quantity: 1,
        idempotencyKey: key,
      }).success
    ).toBe(false)
  })

  it("las bajas exigen causa", () => {
    expect(
      stockWithdrawalSchema.safeParse({
        chipSetId: "s",
        lines: [line(1)],
        reason: "Rotas",
        idempotencyKey: key,
      }).success
    ).toBe(false)
    expect(
      stockWithdrawalSchema.safeParse({
        chipSetId: "s",
        category: "DAMAGE",
        lines: [line(1)],
        reason: "Rotas",
        idempotencyKey: key,
      }).success
    ).toBe(true)
  })

  it("el ajuste: faltante resta, sobrante suma, corrección con dirección obligatoria", () => {
    expect(adjustmentDelta("SHORTAGE", 2)).toBe(-2)
    expect(adjustmentDelta("SURPLUS", 2)).toBe(2)
    expect(adjustmentDelta("CORRECTION", 3, "DECREASE")).toBe(-3)
    expect(() => adjustmentDelta("CORRECTION", 3)).toThrow()
    const base = {
      chipSetId: "s",
      denominationId: "d",
      quantity: 1,
      reason: "Corrección",
      idempotencyKey: key,
    }
    expect(
      adjustmentSchema.safeParse({ ...base, kind: "CORRECTION" }).success
    ).toBe(false)
    expect(
      adjustmentSchema.safeParse({
        ...base,
        kind: "SURPLUS",
        direction: "INCREASE",
      }).success
    ).toBe(false)
  })

  it("los arqueos de apertura/cierre no se crean desde la API (solo CONTROL/INITIAL)", () => {
    expect(
      createCountSchema.safeParse({ chipSetId: "s", countType: "OPENING" })
        .success
    ).toBe(false)
    expect(createCountSchema.parse({ chipSetId: "s" }).countType).toBe(
      "CONTROL"
    )
  })
})

describe("disponibilidad, reservas y circulación", () => {
  it("disponible = custodia − reservadas; las reservadas no se suman aparte", () => {
    expect(availableQuantity({ custody: 50, reserved: 30 })).toBe(20)
    expect(activeInventory({ custody: 50, circulation: 20 })).toBe(70)
    expect(() => availableQuantity({ custody: 5, reserved: 6 })).toThrow()
  })
})

describe("arqueos y conciliación", () => {
  it("la diferencia es contado − esperado, por denominación", () => {
    expect(countDifference(100, 98)).toBe(-2)
    expect(countDifference(10, 11)).toBe(1)
    expect(nominalValue(countDifference(100, 98), "100").toFixed(2)).toBe(
      "-200.00"
    )
  })

  it("un total nominal en cero no significa cuadrado (ARQ-07)", () => {
    const diffs = [countDifference(100, 96), countDifference(50, 51)] // -4×$25, +1×$100
    const total = sumDecimals([
      nominalValue(diffs[0], "25"),
      nominalValue(diffs[1], "100"),
    ])
    expect(total.toFixed(2)).toBe("0.00")
    expect(diffs.some((d) => d !== 0)).toBe(true)
  })

  it("conciliar exige motivo e idempotencia", () => {
    expect(
      reconcileCountSchema.safeParse({ idempotencyKey: key }).success
    ).toBe(false)
    expect(
      reconcileCountSchema.safeParse({ reason: "Recontado" }).success
    ).toBe(false)
  })
})

describe("idempotencia", () => {
  it("la huella ignora la clave y el orden de campos, y detecta contenido distinto", () => {
    const a = requestHash({
      chipSetId: "s",
      reason: "x",
      lines: [line(1)],
      idempotencyKey: "k1",
    })
    const b = requestHash({
      idempotencyKey: "k2",
      lines: [line(1)],
      reason: "x",
      chipSetId: "s",
    })
    const c = requestHash({
      chipSetId: "s",
      reason: "x",
      lines: [line(2)],
      idempotencyKey: "k1",
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("toda operación que mueve inventario exige clave", () => {
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "s",
        lines: [line(1)],
        reason: "Repo",
      }).success
    ).toBe(false)
    expect(
      stockEntrySchema.safeParse({
        chipSetId: "s",
        lines: [line(1)],
        reason: "Repo",
        idempotencyKey: "a b",
      }).success
    ).toBe(false)
  })
})

describe("permisos de inventario", () => {
  it("los tres roles consultan y operan (ajustes y arqueos) sin aprobación adicional", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.CHIPS_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CHIPS_OPERATE)).toBe(true)
    }
    // Las denominaciones (catálogo crítico) siguen siendo solo de SUPERADMIN.
    expect(roleHasPermission("PARTNER", PERMISSIONS.SETTINGS_MANAGE)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.SETTINGS_MANAGE)).toBe(
      false
    )
  })
})

describe("identificadores sembrados por migraciones", () => {
  it("acepta ids con guion bajo o guion (p. ej. chipset_main, m16-folio-*) y rechaza caracteres peligrosos", async () => {
    const { idSchema } = await import("./inventory.schemas")
    const { entityIdSchema } =
      await import("@/modules/settings/settings.schemas")
    for (const id of [
      "chipset_main",
      "container_main",
      "m16-folio-redemption",
      "cmv7bjg680001lgxy3q76ntzx",
    ]) {
      expect(idSchema.safeParse(id).success).toBe(true)
      expect(entityIdSchema.safeParse(id).success).toBe(true)
    }
    for (const id of ["a'b", "../x", "a b", "x".repeat(65)])
      expect(idSchema.safeParse(id).success).toBe(false)
  })
})
