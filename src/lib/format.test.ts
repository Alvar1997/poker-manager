import { describe, expect, it } from "vitest"

import { businessDateOf, formatCurrencyMXN, formatDate } from "@/lib/format"

describe("formatCurrencyMXN", () => {
  it("formatea montos positivos en pesos mexicanos", () => {
    expect(formatCurrencyMXN(1234.5)).toMatch(/\$\s?1,234.50/)
  })

  it("formatea cero", () => {
    expect(formatCurrencyMXN(0)).toMatch(/\$\s?0.00/)
  })
})

describe("formatDate", () => {
  it("formatea una fecha en la zona horaria del negocio (America/Monterrey)", () => {
    const formatted = formatDate(new Date("2026-01-15T12:00:00Z"))
    expect(formatted).toContain("2026")
    expect(formatted.toLowerCase()).toContain("enero")
  })
})

describe("businessDateOf", () => {
  it("resuelve el día calendario correcto en la zona horaria del negocio", () => {
    // 2026-01-15T05:30:00Z == 2026-01-14T23:30:00 en America/Monterrey (UTC-6)
    expect(businessDateOf(new Date("2026-01-15T05:30:00Z"))).toBe("2026-01-14")
  })

  it("una sesión que cruza medianoche en UTC pertenece al día de Monterrey, no al del servidor", () => {
    const utcMidnight = new Date("2026-06-02T00:15:00Z")
    expect(businessDateOf(utcMidnight)).toBe("2026-06-01")
  })
})
