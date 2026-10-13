import { describe, expect, it } from "vitest"

import {
  SETTINGS_SECTIONS,
  settingsSectionsFor,
} from "@/config/settings-sections"

const ids = (role: Parameters<typeof settingsSectionsFor>[0]) =>
  settingsSectionsFor(role).map((s) => s.id)

describe("secciones de configuración por rol", () => {
  it("existen las nueve secciones del Módulo 02", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "general",
      "caja",
      "mesas",
      "fichas",
      "pagos",
      "banco",
      "folios",
      "reglas",
      "whatsapp",
    ])
  })

  it("SUPERADMIN y PARTNER ven todas", () => {
    expect(ids("SUPERADMIN")).toHaveLength(9)
    expect(ids("PARTNER")).toHaveLength(9)
  })

  it("CASHIER solo ve los catálogos necesarios para operar", () => {
    expect(ids("CASHIER")).toEqual([
      "general",
      "mesas",
      "fichas",
      "pagos",
      "reglas",
    ])
  })
})
