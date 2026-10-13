import { describe, expect, it } from "vitest"

import { OPERATIONAL_RULES } from "@/config/operational-rules"
import {
  createDenominationSchema,
  createTableSchema,
  formatFolio,
  updateBankAccountSchema,
  updateBusinessSettingsSchema,
  updateFolioSequenceSchema,
  updatePaymentMethodSchema,
} from "@/modules/settings/settings.schemas"

describe("schemas del Módulo 02", () => {
  it("configuración general: moneda, zona horaria e id no son editables", () => {
    expect(
      updateBusinessSettingsSchema.safeParse({ businessName: "Club" }).success
    ).toBe(true)
    for (const body of [{ currency: "USD" }, { timezone: "UTC" }, { id: 2 }]) {
      expect(updateBusinessSettingsSchema.safeParse(body).success).toBe(false)
    }
  })

  it("mesa: código normalizado, montos string > 0, sin campos de caja", () => {
    const base = {
      code: "table_50_50",
      name: "Mesa 50/50",
      smallBlind: "50",
      bigBlind: "100",
      defaultChipSetId: "abc123",
    }
    expect(createTableSchema.parse(base).code).toBe("TABLE_50_50")
    expect(
      createTableSchema.safeParse({ ...base, smallBlind: "0" }).success
    ).toBe(false)
    expect(
      createTableSchema.safeParse({ ...base, cashBoxId: "x" }).success
    ).toBe(false)
  })

  it("denominación: sin campo de cantidad/existencias", () => {
    expect(createDenominationSchema.safeParse({ value: "25" }).success).toBe(
      true
    )
    expect(
      createDenominationSchema.safeParse({ value: "25", quantity: 100 }).success
    ).toBe(false)
  })

  it("métodos de pago: no se puede cambiar el código (sin MIXED ni CREDIT)", () => {
    expect(updatePaymentMethodSchema.safeParse({ code: "MIXED" }).success).toBe(
      false
    )
  })

  it("cuenta bancaria: limpia espacios/guiones y rechaza credenciales", () => {
    expect(
      updateBankAccountSchema.parse({ clabe: "002 010 0777 7777 7771" }).clabe
    ).toBe("002010077777777771")
    expect(updateBankAccountSchema.safeParse({ password: "x" }).success).toBe(
      false
    )
    expect(
      updateBankAccountSchema.safeParse({ accountNumber: "12" }).success
    ).toBe(false)
  })

  it("folios: formato y límites", () => {
    expect(formatFolio("SES", 1, 6)).toBe("SES-000001")
    expect(formatFolio("CMP", 1234567, 6)).toBe("CMP-1234567")
    expect(
      updateFolioSequenceSchema.safeParse({ prefix: "SES-" }).success
    ).toBe(false)
    expect(updateFolioSequenceSchema.safeParse({ nextNumber: 0 }).success).toBe(
      false
    )
  })
})

describe("reglas operativas fijas", () => {
  it("son 15, con identificadores únicos e incluyen fondo nuevo y retiro total", () => {
    const ids = OPERATIONAL_RULES.map((r) => r.id)
    expect(ids).toHaveLength(15)
    expect(new Set(ids).size).toBe(15)
    expect(ids).toEqual(
      expect.arrayContaining([
        "NEW_FUND_PER_SESSION",
        "FULL_WITHDRAWAL_ON_CLOSE",
        "FIFO_COMPENSATION",
        "SINGLE_CASH_BOX",
      ])
    )
  })
})
