import { describe, expect, it } from "vitest"

import {
  formatPhone,
  maskPhone,
  normalizePhone,
  phoneCountryOptions,
} from "@/lib/phone"

describe("normalizePhone (E.164, México por defecto)", () => {
  it.each([
    ["871 123 4567", "+528711234567"],
    ["(871) 123-4567", "+528711234567"],
    ["8711234567", "+528711234567"],
    ["55 1234 5678", "+525512345678"],
  ])("número nacional mexicano %j → %s", (input, e164) => {
    expect(normalizePhone(input)).toEqual({ e164, country: "MX" })
  })

  it("no duplica +52 cuando ya viene el prefijo", () => {
    expect(normalizePhone("+52 871 123 4567")?.e164).toBe("+528711234567")
    expect(normalizePhone("0052 871 123 4567")?.e164).toBe("+528711234567")
    expect(normalizePhone("+52 871 123 4567")?.e164).not.toContain("+5252")
  })

  it("acepta el antiguo 1 de celulares mexicanos y lo descarta", () => {
    expect(normalizePhone("+52 1 871 123 4567")?.e164).toBe("+528711234567")
  })

  it("acepta números internacionales válidos con +código o país elegido", () => {
    expect(normalizePhone("+1 202 555 0123")).toEqual({
      e164: "+12025550123",
      country: "US",
    })
    expect(normalizePhone("612 345 678", "ES")).toEqual({
      e164: "+34612345678",
      country: "ES",
    })
    expect(normalizePhone("0034 612 345 678")).toEqual({
      e164: "+34612345678",
      country: "ES",
    })
  })

  it.each([
    "",
    "   ",
    "12345",
    "871 123",
    "abc defg hij",
    "+52 871 123 45678 9",
    "612 345 678",
  ])("rechaza %j (estructura o longitud inválida para el país)", (input) => {
    expect(normalizePhone(input)).toBeNull()
  })
})

describe("presentación", () => {
  it("formatea y enmascara", () => {
    expect(formatPhone("+528711234567")).toBe("+52 871 123 4567")
    expect(maskPhone("+528711234567")).toBe("+52 •••• 4567")
  })

  it("lista países en español con México primero", () => {
    const options = phoneCountryOptions()
    expect(options[0]).toEqual({
      code: "MX",
      name: "México",
      callingCode: "52",
    })
    expect(options.find((o) => o.code === "US")?.callingCode).toBe("1")
  })
})
