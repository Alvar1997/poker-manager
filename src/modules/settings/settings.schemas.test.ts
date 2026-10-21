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
  it("son 24, con identificadores únicos e incluyen apertura en $0, retiro total y crédito sin límite", () => {
    const ids = OPERATIONAL_RULES.map((r) => r.id)
    expect(ids).toHaveLength(24)
    expect(new Set(ids).size).toBe(24)
    // Módulo 11: la compensación ya no es automática; la firma es obligatoria siempre.
    expect(ids).not.toContain("AUTO_DEBT_COMPENSATION")
    expect(ids).not.toContain("NEW_FUND_PER_SESSION")
    // Módulo 08: ya no existe crédito sin registrar al socio autorizador.
    expect(ids).not.toContain("CREDIT_NO_EXTERNAL_APPROVAL")
    expect(ids).toEqual(
      expect.arrayContaining([
        "ZERO_OPENING_BALANCE",
        "CHIP_COUNT_BEFORE_OPENING",
        "NO_OPERATING_EXPENSES",
        "FULL_WITHDRAWAL_ON_CLOSE",
        "FIFO_COMPENSATION",
        "OPTIONAL_DEBT_COMPENSATION",
        "SETTLEMENT_SIGNATURE_ALWAYS",
        "SINGLE_CASH_BOX",
        "NO_CREDIT_LIMIT",
      ])
    )
  })
})
