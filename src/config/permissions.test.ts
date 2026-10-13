import { beforeEach, describe, expect, it, vi } from "vitest"

import { ForbiddenError, UnauthorizedError } from "@/lib/errors"

const mockAuth = vi.fn()

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}))

// Importar después del mock para que @/lib/auth ya esté interceptado.
const { getCurrentUser, hasRole, requireRole, requireUser } =
  await import("@/config/permissions")

function session(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user: {
      id: "user-1",
      name: "Ana",
      email: "ana@example.com",
      role: "CASHIER",
      isActive: true,
      ...overrides,
    },
  }
}

describe("getCurrentUser", () => {
  beforeEach(() => mockAuth.mockReset())

  it("devuelve null si no hay sesión", async () => {
    mockAuth.mockResolvedValue(null)
    expect(await getCurrentUser()).toBeNull()
  })

  it("devuelve el usuario mapeado si hay sesión", async () => {
    mockAuth.mockResolvedValue(session())
    const user = await getCurrentUser()
    expect(user).toMatchObject({ id: "user-1", role: "CASHIER" })
  })
})

describe("requireUser", () => {
  beforeEach(() => mockAuth.mockReset())

  it("lanza UnauthorizedError sin sesión", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it("lanza UnauthorizedError si el usuario está desactivado", async () => {
    mockAuth.mockResolvedValue(session({ isActive: false }))
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it("devuelve el usuario si la sesión es válida y está activo", async () => {
    mockAuth.mockResolvedValue(session())
    await expect(requireUser()).resolves.toMatchObject({ role: "CASHIER" })
  })
})

describe("requireRole", () => {
  beforeEach(() => mockAuth.mockReset())

  it("permite el acceso cuando el rol está en la lista permitida", async () => {
    mockAuth.mockResolvedValue(session({ role: "SUPERADMIN" }))
    await expect(requireRole("SUPERADMIN", "PARTNER")).resolves.toMatchObject({
      role: "SUPERADMIN",
    })
  })

  it("lanza ForbiddenError (acceso no autorizado) cuando el rol no está permitido", async () => {
    mockAuth.mockResolvedValue(session({ role: "CASHIER" }))
    await expect(requireRole("SUPERADMIN", "PARTNER")).rejects.toBeInstanceOf(
      ForbiddenError
    )
  })

  it("lanza UnauthorizedError (no ForbiddenError) si ni siquiera hay sesión", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(requireRole("SUPERADMIN")).rejects.toBeInstanceOf(
      UnauthorizedError
    )
  })
})

describe("hasRole", () => {
  beforeEach(() => mockAuth.mockReset())

  it("no lanza: devuelve false cuando no corresponde", async () => {
    mockAuth.mockResolvedValue(session({ role: "CASHIER" }))
    expect(await hasRole("SUPERADMIN")).toBe(false)
  })

  it("devuelve true cuando el rol coincide y está activo", async () => {
    mockAuth.mockResolvedValue(session({ role: "PARTNER" }))
    expect(await hasRole("PARTNER", "SUPERADMIN")).toBe(true)
  })

  it("devuelve false si el usuario está desactivado aunque el rol coincida", async () => {
    mockAuth.mockResolvedValue(session({ role: "PARTNER", isActive: false }))
    expect(await hasRole("PARTNER")).toBe(false)
  })
})
