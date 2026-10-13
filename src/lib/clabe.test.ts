import { describe, expect, it } from "vitest"

import { isValidClabe, maskLast4 } from "@/lib/clabe"

describe("isValidClabe", () => {
  it("acepta CLABE con dígito de control correcto", () => {
    // Dígito de control calculado con el algoritmo oficial (pesos 3,7,1).
    expect(isValidClabe("002010077777777771")).toBe(true)
    expect(isValidClabe("032180000118359719")).toBe(true)
  })

  it("rechaza dígito de control incorrecto, longitud o caracteres inválidos", () => {
    expect(isValidClabe("002010077777777772")).toBe(false)
    expect(isValidClabe("00201007777777777")).toBe(false)
    expect(isValidClabe("00201007777777777A")).toBe(false)
  })
})

describe("maskLast4", () => {
  it("muestra solo los últimos 4 dígitos", () => {
    expect(maskLast4("1234")).toBe("•••• 1234")
    expect(maskLast4(null)).toBeNull()
  })
})
