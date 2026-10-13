import { beforeEach, describe, expect, it, vi } from "vitest"

import { ForbiddenError, UnauthorizedError } from "@/lib/errors"

const mockAuth = vi.fn()
const mockLoadSessionUser = vi.fn()
const mockRecordAuditSafe = vi.fn()
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }))
vi.mock("@/modules/auth/auth.service", () => ({
  loadSessionUser: (...args: unknown[]) => mockLoadSessionUser(...args),
}))
vi.mock("@/modules/audit/audit.service", () => ({
  AUDIT_ACTIONS: { ACCESS_DENIED: "AUTH_ACCESS_DENIED" },
  recordAuditSafe: (...args: unknown[]) => mockRecordAuditSafe(...args),
}))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}))

// Importar después de los mocks.
const {
  PERMISSIONS,
  can,
  getCurrentUser,
  requirePagePermission,
  requirePermission,
  requireUser,
} = await import("@/config/permissions")

function dbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    name: "Ana",
    email: "ana@example.com",
    role: "CASHIER",
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 0,
    ...overrides,
  }
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: "user-1",
      role: "CASHIER",
      isActive: true,
      sessionVersion: 0,
      ...overrides,
    },
  }
}

beforeEach(() => {
  mockAuth.mockReset()
  mockLoadSessionUser.mockReset()
  mockRecordAuditSafe.mockReset()
  mockRedirect.mockClear()
})

describe("getCurrentUser", () => {
  it("devuelve null si no hay sesión (sin tocar la base)", async () => {
    mockAuth.mockResolvedValue(null)
    expect(await getCurrentUser()).toBeNull()
    expect(mockLoadSessionUser).not.toHaveBeenCalled()
  })

  it("valida contra la base el id y la sessionVersion del token", async () => {
    mockAuth.mockResolvedValue(session({ sessionVersion: 3 }))
    mockLoadSessionUser.mockResolvedValue(dbUser({ sessionVersion: 3 }))
    await getCurrentUser()
    expect(mockLoadSessionUser).toHaveBeenCalledWith("user-1", 3)
  })

  it("usa el rol de la BASE aunque el JWT diga otro (no confía en el navegador)", async () => {
    mockAuth.mockResolvedValue(session({ role: "SUPERADMIN" }))
    mockLoadSessionUser.mockResolvedValue(dbUser({ role: "CASHIER" }))
    expect(await getCurrentUser()).toMatchObject({ role: "CASHIER" })
  })
})

describe("requireUser", () => {
  it("lanza UnauthorizedError (401) sin sesión", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it("lanza UnauthorizedError si la sesión fue revocada o el usuario se desactivó", async () => {
    mockAuth.mockResolvedValue(session())
    mockLoadSessionUser.mockResolvedValue(null)
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError)
  })
})

describe("requirePermission", () => {
  it("permite cuando el rol vigente tiene el permiso", async () => {
    mockAuth.mockResolvedValue(session())
    mockLoadSessionUser.mockResolvedValue(dbUser({ role: "SUPERADMIN" }))
    await expect(
      requirePermission(PERMISSIONS.USERS_CREATE)
    ).resolves.toMatchObject({ role: "SUPERADMIN" })
  })

  it("lanza ForbiddenError (403) y audita el intento cuando falta el permiso", async () => {
    mockAuth.mockResolvedValue(session())
    mockLoadSessionUser.mockResolvedValue(dbUser({ role: "PARTNER" }))
    await expect(
      requirePermission(PERMISSIONS.USERS_CREATE, { requestId: "req-1" })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockRecordAuditSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH_ACCESS_DENIED",
        result: "DENIED",
        entityId: PERMISSIONS.USERS_CREATE,
        actorUserId: "user-1",
        requestId: "req-1",
      })
    )
  })

  it("lanza UnauthorizedError (no Forbidden) si no hay sesión", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(
      requirePermission(PERMISSIONS.DASHBOARD_VIEW)
    ).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it("bloquea todo permiso mientras haya una credencial temporal", async () => {
    mockAuth.mockResolvedValue(session())
    mockLoadSessionUser.mockResolvedValue(
      dbUser({ role: "SUPERADMIN", mustChangePassword: true })
    )
    await expect(
      requirePermission(PERMISSIONS.DASHBOARD_VIEW)
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe("requirePagePermission", () => {
  it("redirige a /login sin sesión", async () => {
    mockAuth.mockResolvedValue(null)
    await expect(requirePagePermission(PERMISSIONS.USERS_READ)).rejects.toThrow(
      "REDIRECT:/login"
    )
  })

  it("redirige a la pantalla de acceso denegado sin permiso", async () => {
    mockAuth.mockResolvedValue(session())
    mockLoadSessionUser.mockResolvedValue(dbUser({ role: "CASHIER" }))
    await expect(
      requirePagePermission(PERMISSIONS.USERS_READ, "/dashboard/users")
    ).rejects.toThrow("REDIRECT:/dashboard/access-denied")
    expect(mockRecordAuditSafe).toHaveBeenCalled()
  })
})

describe("can", () => {
  it("false sin usuario o con credencial temporal", () => {
    expect(can(null, PERMISSIONS.DASHBOARD_VIEW)).toBe(false)
    expect(
      can(
        { role: "SUPERADMIN", mustChangePassword: true },
        PERMISSIONS.DASHBOARD_VIEW
      )
    ).toBe(false)
    expect(
      can({ role: "PARTNER", mustChangePassword: false }, PERMISSIONS.CASH_READ)
    ).toBe(true)
  })
})
