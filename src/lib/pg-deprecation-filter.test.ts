import { describe, expect, it, vi } from "vitest"

import {
  installPgDeprecationFilter,
  isPgConcurrentQueryWarning,
} from "@/lib/pg-deprecation-filter"

const PG_MESSAGE =
  "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."

describe("pg-deprecation-filter", () => {
  it("reconoce solo la advertencia de consultas concurrentes de pg", () => {
    expect(isPgConcurrentQueryWarning(PG_MESSAGE)).toBe(true)
    expect(isPgConcurrentQueryWarning(new Error(PG_MESSAGE))).toBe(true)
    expect(isPgConcurrentQueryWarning("Buffer() is deprecated")).toBe(false)
    expect(isPgConcurrentQueryWarning(undefined)).toBe(false)
  })

  it("oculta esa advertencia y deja pasar las demás", () => {
    installPgDeprecationFilter()
    installPgDeprecationFilter() // idempotente
    const listener = vi.fn()
    process.on("warning", listener)
    process.emitWarning(PG_MESSAGE, "DeprecationWarning")
    process.emitWarning("otra advertencia", "DeprecationWarning", "X_TEST")
    // Node emite las advertencias en el siguiente tick.
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        process.off("warning", listener)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener.mock.calls[0]?.[0]?.message).toBe("otra advertencia")
        resolve()
      })
    })
  })
})
