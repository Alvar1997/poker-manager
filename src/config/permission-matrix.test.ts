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
      PERMISSIONS.SPECIAL_OPS_AUTHORIZE,
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

  it("reportes (Módulo 14): los tres roles consultan reportes operativos y financieros y exportan XLSX", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_VIEW)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_FINANCIAL)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.REPORTS_EXPORT)).toBe(true)
    }
  })

  it("Módulo 15: los tres roles consultan auditoría y solicitan correcciones; solo PARTNER/SUPERADMIN autorizan; recuperación solo SUPERADMIN", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.AUDIT_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.CORRECTIONS_REQUEST)).toBe(
        true
      )
      expect(roleHasPermission(role, PERMISSIONS.INTEGRITY_RUN)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.INCIDENTS_MANAGE)).toBe(true)
    }
    for (const role of ["SUPERADMIN", "PARTNER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.CORRECTIONS_OPERATE)).toBe(
        true
      )
      expect(roleHasPermission(role, PERMISSIONS.INCIDENTS_RESOLVE)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.BACKUPS_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.SYSTEM_HEALTH_READ)).toBe(true)
    }
    expect(roleHasPermission("CASHIER", PERMISSIONS.INCIDENTS_RESOLVE)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.BACKUPS_READ)).toBe(false)
    expect(roleHasPermission("CASHIER", PERMISSIONS.SYSTEM_HEALTH_READ)).toBe(
      false
    )
    expect(roleHasPermission("SUPERADMIN", PERMISSIONS.RECOVERY_MANAGE)).toBe(
      true
    )
    expect(roleHasPermission("PARTNER", PERMISSIONS.RECOVERY_MANAGE)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.RECOVERY_MANAGE)).toBe(
      false
    )
    expect(roleHasPermission("PARTNER", PERMISSIONS.AUDIT_SECURITY_READ)).toBe(
      false
    )
  })

  it("CASHIER no autoriza correcciones ni ve el dashboard financiero administrativo", () => {
    expect(roleHasPermission("CASHIER", PERMISSIONS.DASHBOARD_FINANCIAL)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.CORRECTIONS_OPERATE)).toBe(
      false
    )
  })

  it("cierre de sesión (Módulo 12): los tres preparan; solo PARTNER y SUPERADMIN confirman y autorizan ajustes", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.SESSIONS_MANAGE)).toBe(true)
    }
    expect(
      roleHasPermission("SUPERADMIN", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(true)
    expect(
      roleHasPermission("PARTNER", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(true)
    expect(
      roleHasPermission("CASHIER", PERMISSIONS.SESSIONS_CLOSE_AUTHORIZE)
    ).toBe(false)
  })

  it("deniega por defecto un rol o permiso desconocido", () => {
    expect(roleHasPermission("HACKER" as Role, PERMISSIONS.USERS_READ)).toBe(
      false
    )
    expect(roleHasPermission("SUPERADMIN", "users:delete" as never)).toBe(false)
    expect(permissionsForRole("HACKER" as Role)).toEqual([])
  })

  it("configuración (Módulo 02): SUPERADMIN edita; PARTNER consulta todo; CASHIER solo catálogos", () => {
    expect(roleHasPermission("SUPERADMIN", PERMISSIONS.SETTINGS_MANAGE)).toBe(
      true
    )
    expect(roleHasPermission("PARTNER", PERMISSIONS.SETTINGS_READ)).toBe(true)
    expect(roleHasPermission("PARTNER", PERMISSIONS.CATALOGS_READ)).toBe(true)
    expect(roleHasPermission("PARTNER", PERMISSIONS.SETTINGS_MANAGE)).toBe(
      false
    )
    expect(roleHasPermission("CASHIER", PERMISSIONS.CATALOGS_READ)).toBe(true)
    expect(roleHasPermission("CASHIER", PERMISSIONS.SETTINGS_READ)).toBe(false)
    expect(roleHasPermission("CASHIER", PERMISSIONS.SETTINGS_MANAGE)).toBe(
      false
    )
  })

  it("jugadores (Módulo 03): los tres roles registran, consultan, editan, activan y registran consentimiento", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      for (const permission of [
        PERMISSIONS.PLAYERS_READ,
        PERMISSIONS.PLAYERS_CREATE,
        PERMISSIONS.PLAYERS_UPDATE,
        PERMISSIONS.PLAYERS_MANAGE,
        PERMISSIONS.PLAYERS_CONSENT,
      ]) {
        expect(roleHasPermission(role, permission)).toBe(true)
      }
    }
    // Historial telefónico y auditoría del jugador: datos personales históricos.
    expect(roleHasPermission("PARTNER", PERMISSIONS.AUDIT_READ)).toBe(true)
  })

  it("los valores de permiso son únicos (sin alias que se pisen)", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length)
  })

  it("Módulo 16: los tres roles operan operaciones especiales; solo PARTNER y SUPERADMIN autorizan", () => {
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const) {
      expect(roleHasPermission(role, PERMISSIONS.SPECIAL_OPS_READ)).toBe(true)
      expect(roleHasPermission(role, PERMISSIONS.SPECIAL_OPS_OPERATE)).toBe(
        true
      )
    }
    expect(
      roleHasPermission("CASHIER", PERMISSIONS.SPECIAL_OPS_AUTHORIZE)
    ).toBe(false)
    expect(
      roleHasPermission("PARTNER", PERMISSIONS.SPECIAL_OPS_AUTHORIZE)
    ).toBe(true)
    expect(
      roleHasPermission("SUPERADMIN", PERMISSIONS.SPECIAL_OPS_AUTHORIZE)
    ).toBe(true)
  })
})
