import { describe, expect, it } from "vitest"

import { positiveMoneySchema } from "@/lib/money"

describe("positiveMoneySchema (montos como string, nunca Float)", () => {
  it.each(["1", "25", "25.5", "25.50", "0.01", "1000000"])("acepta %s", (v) => {
    expect(positiveMoneySchema.safeParse(v).success).toBe(true)
  })

  it.each(["0", "0.00", "-1", "1.234", "abc", "", "1e3", " "])(
    "rechaza %j",
    (v) => {
      expect(positiveMoneySchema.safeParse(v).success).toBe(false)
    }
  )

  it("rechaza números (no string)", () => {
    expect(positiveMoneySchema.safeParse(25).success).toBe(false)
  })
})
