import { describe, expect, it } from "vitest"

import { NAV_ITEMS, navigationFor } from "@/config/navigation"

const ids = (role: Parameters<typeof navigationFor>[0]) =>
  navigationFor(role).map((item) => item.id)

describe("navegación por capacidades", () => {
  it("SUPERADMIN ve todas las opciones", () => {
    expect(ids("SUPERADMIN")).toEqual(NAV_ITEMS.map((item) => item.id))
  })

  it("PARTNER ve todo lo operativo y financiero, sin usuarios ni configuración", () => {
    const partner = ids("PARTNER")
    expect(partner).toEqual(
      expect.arrayContaining([
        "home",
        "sessions",
        "cash",
        "credits",
        "settlements",
        "reports",
        "audit",
        "chips",
        "profile",
      ])
    )
    expect(partner).not.toContain("users")
    expect(partner).not.toContain("settings")
  })

  it("CASHIER ve solo lo necesario para operar sesión y caja", () => {
    const cashier = ids("CASHIER")
    expect(cashier).toEqual(
      expect.arrayContaining([
        "home",
        "sessions",
        "players",
        "purchases",
        "chips",
        "cash",
        "credits",
        "settlements",
        "profile",
      ])
    )
    for (const hidden of ["users", "settings", "reports", "audit"]) {
      expect(cashier).not.toContain(hidden)
    }
  })

  it("los módulos aún no construidos se marcan como no disponibles", () => {
    const available = NAV_ITEMS.filter((item) => item.available).map(
      (item) => item.id
    )
    expect(available.sort()).toEqual(["home", "profile", "users"])
  })
})
