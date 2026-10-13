import { describe, expect, it } from "vitest"
import { z } from "zod"

import { ValidationError } from "@/lib/errors"
import {
  nonNegativeInt,
  parseJsonBody,
  parseQueryParams,
} from "@/lib/validation"

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
})

describe("parseJsonBody", () => {
  it("devuelve los datos parseados cuando el body es válido", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ name: "Ana", age: 30 }),
    })

    const result = await parseJsonBody(request, schema)
    expect(result).toEqual({ name: "Ana", age: 30 })
  })

  it("lanza ValidationError si el JSON es inválido", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "{not-json",
    })

    await expect(parseJsonBody(request, schema)).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it("lanza ValidationError con detalles si no cumple el schema", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ name: "", age: -1 }),
    })

    await expect(parseJsonBody(request, schema)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
  })
})

describe("parseQueryParams", () => {
  const querySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
  })

  it("parsea query params válidos", () => {
    const params = new URLSearchParams({ page: "2" })
    expect(parseQueryParams(params, querySchema)).toEqual({ page: 2 })
  })

  it("lanza ValidationError si el valor no cumple el schema", () => {
    const params = new URLSearchParams({ page: "-1" })
    expect(() => parseQueryParams(params, querySchema)).toThrow(ValidationError)
  })
})

describe("nonNegativeInt", () => {
  it("acepta enteros no negativos", () => {
    expect(() => nonNegativeInt("fichas")(0)).not.toThrow()
    expect(() => nonNegativeInt("fichas")(42)).not.toThrow()
  })

  it("rechaza negativos, decimales y no-números", () => {
    expect(() => nonNegativeInt("fichas")(-1)).toThrow(ValidationError)
    expect(() => nonNegativeInt("fichas")(1.5)).toThrow(ValidationError)
    expect(() => nonNegativeInt("fichas")("10")).toThrow(ValidationError)
  })
})
