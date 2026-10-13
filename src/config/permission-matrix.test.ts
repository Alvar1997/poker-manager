import { describe, expect, it } from "vitest"

import {
  ADMIN_ONLY_PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  type Role,
} from "@/config/permission-matrix"

const FINANCIAL_READ = [
  PERMISSIONS.DASHBOARD_FINANCIAL,
  PERMISSIONS.CASH_READ,
  PERMISSIONS.CREDITS_READ,
  PERMISSIONS.SETTLEMENTS_READ,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.REPORTS_FINANCIAL,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.SIGNATURES_READ,
]

const CASH_OPERATIONS = [
  PERMISSIONS.SESSIONS_MANAGE,
  PERMISSIONS.CASH_OPERATE,
  PERMISSIONS.PURCHASES_CREATE,
  PERMISSIONS.CREDITS_OPERATE,
  PERMISSIONS.SETTLEMENTS_OPERATE,
  PERMISSIONS.CHIPS_OPERATE,
]

describe("matriz de permisos", () => {
  it("SUPERADMIN tiene todos los permisos", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(roleHasPermission("SUPERADMIN", permission)).toBe(true)
    }
  })

  it("SUPERADMIN puede crear usuarios y administrar roles", () => {
    expect(roleHasPermission("SUPERADMIN", PERMISSIONS.USERS_CREATE)).toBe(true)
    expect(roleHasPermission("SUPERADMIN", PERMISSIONS.ROLES_MANAGE)).toBe(true)
  })

  it.each<Role>(["PARTNER", "CASHIER"])(
    "%s no puede crear, editar, desactivar usuarios ni administrar roles/seguridad",
    (role) => {
      for (const permission of ADMIN_ONLY_PERMISSIONS) {
        expect(roleHasPermission(role, permission)).toBe(false)
      }
    }
  )

  it("PARTNER tiene permisos de consulta financiera", () => {
    for (const permission of FINANCIAL_READ) {
      expect(roleHasPermission("PARTNER", permission)).toBe(true)
    }
  })

  it("PARTNER tiene permisos operativos de caja y correcciones autorizadas", () => {
    for (const permission of [
      ...CASH_OPERATIONS,
      PERMISSIONS.CORRECTIONS_OPERATE,
    ]) {
      expect(roleHasPermission("PARTNER", permission)).toBe(true)
    }
  })

  it("PARTNER tiene exactamente todo excepto los permisos administrativos", () => {
    const expected = ALL_PERMISSIONS.filter(
      (p) => !ADMIN_ONLY_PERMISSIONS.includes(p)
    ).sort()
    expect(permissionsForRole("PARTNER").sort()).toEqual(expected)
  })

  it("CASHIER puede ejecutar las operaciones de caja autorizadas", () => {
    for (const permission of [
      ...CASH_OPERATIONS,
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.SIGNATURES_CAPTURE,
      PERMISSIONS.PLAYERS_MANAGE,
      PERMISSIONS.CREDITS_READ,
    ]) {
      expect(roleHasPermission("CASHIER", permission)).toBe(true)
    }
  })

  it("CASHIER no accede a reportes restringidos ni a datos financieros globales", () => {
    expect(roleHasPermission("CASHIER", PERMISSIONS.REPORTS_FINANCIAL)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.REPORTS_VIEW)).toBe(false)
    expect(roleHasPermission("CASHIER", PERMISSIONS.DASHBOARD_FINANCIAL)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.AUDIT_READ)).toBe(false)
    expect(roleHasPermission("CASHIER", PERMISSIONS.CORRECTIONS_OPERATE)).toBe(
      false
    )
  })

  it("deniega por defecto un rol o permiso desconocido", () => {
    expect(roleHasPermission("HACKER" as Role, PERMISSIONS.USERS_READ)).toBe(
      false
    )
    expect(roleHasPermission("SUPERADMIN", "users:delete" as never)).toBe(false)
    expect(permissionsForRole("HACKER" as Role)).toEqual([])
  })

  it("los valores de permiso son únicos (sin alias que se pisen)", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
  })
})
