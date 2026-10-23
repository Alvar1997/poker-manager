import { describe, expect, it } from "vitest"

import { PERMISSIONS, roleHasPermission } from "@/config/permission-matrix"
import { businessDateOf } from "@/lib/format"
import { moduleOfAction } from "@/modules/audit/audit-taxonomy"
import { AUDIT_ACTIONS } from "@/modules/audit/audit.service"
import {
  checkHistoricalDate,
  compactBusinessDate,
  formatBusinessDateMx,
  formatSessionFolio,
  isCalendarDate,
  padSessionSequence,
  parseSessionFolio,
} from "@/modules/sessions/session-folio"
import { createSessionSchema } from "@/modules/sessions/session.schemas"

const KEY = "11111111-2222-3333-4444-555555555555"

describe("folio S-0001-YYYYMMDD", () => {
  it("1-2. formato con consecutivo de cuatro dígitos", () => {
    expect(formatSessionFolio(1, "2026-10-14")).toBe("S-0001-20261014")
    expect(formatSessionFolio(42, "2026-10-17")).toBe("S-0042-20261017")
    expect(padSessionSequence(9999)).toBe("9999")
  })

  it("3. más de 9999 continúa sin truncar", () => {
    expect(formatSessionFolio(10000, "2026-10-14")).toBe("S-10000-20261014")
    expect(formatSessionFolio(123456, "2027-01-02")).toBe("S-123456-20270102")
  })

  it("4. sufijo YYYYMMDD de la fecha operativa", () => {
    expect(compactBusinessDate("2026-01-05")).toBe("20260105")
    expect(() => compactBusinessDate("2026-02-30")).toThrow()
    expect(() => compactBusinessDate("14/10/2026")).toThrow()
  })

  it("5-6. la misma fecha con consecutivos distintos da folios únicos", () => {
    const a = formatSessionFolio(1, "2026-10-14")
    const b = formatSessionFolio(4, "2026-10-14")
    expect(a).not.toBe(b)
    expect(parseSessionFolio(b)).toEqual({
      sequenceNumber: 4,
      businessDate: "2026-10-14",
    })
  })

  it("el consecutivo es siempre un entero positivo", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => padSessionSequence(bad)).toThrow()
  })

  it("desarma solo folios válidos (el formato anterior no aplica)", () => {
    expect(parseSessionFolio("SES-000001")).toBeNull()
    expect(parseSessionFolio("S-001-20261014")).toBeNull()
    expect(parseSessionFolio("S-0001-20261332")).toBeNull()
  })

  it("muestra la fecha operativa en formato mexicano", () => {
    expect(formatBusinessDateMx("2026-10-14")).toBe("14/10/2026")
  })
})

describe("fecha operativa y captura histórica", () => {
  const today = "2026-10-23"

  it("13. una fecha pasada es válida", () => {
    expect(checkHistoricalDate("2026-10-14", today)).toEqual({ ok: true })
  })

  it("14. una fecha futura se rechaza", () => {
    expect(checkHistoricalDate("2026-10-24", today)).toEqual({
      ok: false,
      reason: "FUTURE",
    })
  })

  it("15. la fecha de hoy se rechaza en modo histórico", () => {
    expect(checkHistoricalDate(today, today)).toEqual({
      ok: false,
      reason: "TODAY",
    })
  })

  it("fechas inválidas o absurdamente antiguas se rechazan", () => {
    expect(checkHistoricalDate("2026-02-30", today).ok).toBe(false)
    expect(checkHistoricalDate("1999-12-31", today)).toEqual({
      ok: false,
      reason: "TOO_OLD",
    })
    expect(isCalendarDate("2024-02-29")).toBe(true)
    expect(isCalendarDate("2026-02-29")).toBe(false)
  })

  it("18. una sesión que cruza medianoche conserva el día en que comenzó (zona del negocio)", () => {
    // 14 oct 21:00 Monterrey = 15 oct 03:00 UTC; termina 15 oct 03:30 local.
    const start = new Date("2026-10-15T03:00:00Z")
    const end = new Date("2026-10-15T09:30:00Z")
    expect(businessDateOf(start)).toBe("2026-10-14")
    expect(businessDateOf(end)).toBe("2026-10-15")
    expect(formatSessionFolio(1, businessDateOf(start))).toBe("S-0001-20261014")
  })
})

describe("validación de entrada (backend)", () => {
  it("8. sesión normal: sin fecha (la fija el servidor)", () => {
    expect(createSessionSchema.safeParse({ idempotencyKey: KEY }).success).toBe(
      true
    )
  })

  it("9. sesión histórica: exige la fecha original", () => {
    expect(
      createSessionSchema.safeParse({
        idempotencyKey: KEY,
        historical: true,
        businessDate: "2026-10-14",
      }).success
    ).toBe(true)
    expect(
      createSessionSchema.safeParse({ idempotencyKey: KEY, historical: true })
        .success
    ).toBe(false)
  })

  it("una fecha sin modo histórico, folios o consecutivos del cliente → 400", () => {
    expect(
      createSessionSchema.safeParse({
        idempotencyKey: KEY,
        businessDate: "2026-10-14",
      }).success
    ).toBe(false)
    expect(
      createSessionSchema.safeParse({
        idempotencyKey: KEY,
        folio: "S-0001-20261014",
      }).success
    ).toBe(false)
    expect(
      createSessionSchema.safeParse({ idempotencyKey: KEY, sequenceNumber: 7 })
        .success
    ).toBe(false)
    expect(
      createSessionSchema.safeParse({
        idempotencyKey: KEY,
        historical: true,
        businessDate: "14/10/2026",
      }).success
    ).toBe(false)
  })
})

describe("permisos y auditoría", () => {
  it("10-12. solo SUPERADMIN tiene la captura histórica", () => {
    expect(
      roleHasPermission("SUPERADMIN", PERMISSIONS.SESSIONS_HISTORICAL_CREATE)
    ).toBe(true)
    expect(
      roleHasPermission("PARTNER", PERMISSIONS.SESSIONS_HISTORICAL_CREATE)
    ).toBe(false)
    expect(
      roleHasPermission("CASHIER", PERMISSIONS.SESSIONS_HISTORICAL_CREATE)
    ).toBe(false)
    // La creación normal sigue disponible para los tres roles.
    for (const role of ["SUPERADMIN", "PARTNER", "CASHIER"] as const)
      expect(roleHasPermission(role, PERMISSIONS.SESSIONS_MANAGE)).toBe(true)
  })

  it("24. los eventos de folio y captura histórica se clasifican en Sesiones", () => {
    for (const a of [
      AUDIT_ACTIONS.SESSION_FOLIO_ASSIGNED,
      AUDIT_ACTIONS.SESSION_FOLIO_MIGRATED,
      AUDIT_ACTIONS.HISTORICAL_SESSION_CREATED,
      AUDIT_ACTIONS.HISTORICAL_SESSION_CREATION_REJECTED,
    ])
      expect(moduleOfAction(a), a).toBe("SESSIONS")
  })
})
