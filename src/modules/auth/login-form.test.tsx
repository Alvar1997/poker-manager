import { describe, expect, it, vi } from "vitest"

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const { safeCallbackUrl } = await import("@/modules/auth/login-form")

describe("safeCallbackUrl", () => {
  it("acepta rutas internas", () => {
    expect(safeCallbackUrl("/dashboard/users")).toBe("/dashboard/users")
  })

  it.each([
    null,
    "",
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
  ])("rechaza %s y vuelve al dashboard", (value) => {
    expect(safeCallbackUrl(value)).toBe("/dashboard")
  })
})
