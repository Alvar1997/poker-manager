import { describe, expect, it } from "vitest"

import { assertSameOrigin } from "@/lib/api-handler"
import { ForbiddenError } from "@/lib/errors"

function request(method: string, headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/users", {
    method,
    headers: { host: "localhost:3000", ...headers },
  })
}

describe("assertSameOrigin (defensa CSRF)", () => {
  it("permite métodos seguros desde cualquier origen", () => {
    expect(() =>
      assertSameOrigin(request("GET", { origin: "https://evil.example" }))
    ).not.toThrow()
  })

  it("permite mutaciones del mismo origen", () => {
    expect(() =>
      assertSameOrigin(
        request("POST", {
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        })
      )
    ).not.toThrow()
  })

  it("rechaza mutaciones con Origin de otro sitio", () => {
    expect(() =>
      assertSameOrigin(request("PATCH", { origin: "https://evil.example" }))
    ).toThrow(ForbiddenError)
  })

  it("rechaza mutaciones marcadas cross-site por el navegador", () => {
    expect(() =>
      assertSameOrigin(request("POST", { "sec-fetch-site": "cross-site" }))
    ).toThrow(ForbiddenError)
  })

  it("rechaza un Origin malformado", () => {
    expect(() => assertSameOrigin(request("POST", { origin: "null" }))).toThrow(
      ForbiddenError
    )
  })
})
