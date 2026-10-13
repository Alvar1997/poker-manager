import { describe, expect, it } from "vitest"

import { sanitizeMetadata } from "@/modules/audit/audit.service"

describe("sanitizeMetadata", () => {
  it("elimina recursivamente claves con secretos", () => {
    expect(
      sanitizeMetadata({
        email: "ana@example.com",
        password: "x",
        passwordHash: "y",
        nested: { token: "t", authorization: "Bearer", ok: 1 },
        list: [{ secret: "s", role: "CASHIER" }],
      })
    ).toEqual({
      email: "ana@example.com",
      nested: { ok: 1 },
      list: [{ role: "CASHIER" }],
    })
  })

  it("serializa fechas a ISO", () => {
    const date = new Date("2026-01-01T00:00:00.000Z")
    expect(sanitizeMetadata({ at: date })).toEqual({
      at: "2026-01-01T00:00:00.000Z",
    })
  })
})
