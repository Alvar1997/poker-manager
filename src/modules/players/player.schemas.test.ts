import { describe, expect, it } from "vitest"

import { CREDIT_POLICY, isWithinCreditPolicy } from "@/config/credit-policy"
import { WHATSAPP_CONSENT_NOTICE_VERSION } from "@/modules/players/consent-notice"
import {
  assertPlayerSelectable,
  isPlayerSelectable,
} from "@/modules/players/player.rules"
import {
  consentActionSchema,
  createPlayerSchema,
  listPlayersQuerySchema,
  updatePlayerSchema,
} from "@/modules/players/player.schemas"
import { deriveConsentStatus } from "@/modules/players/player.service"
import { BusinessRuleError } from "@/lib/errors"

const base = { name: "Juan Pérez", phone: "871 123 4567" }
const grant = {
  action: "GRANTED",
  noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
  source: "IN_PERSON",
  confirmedByPlayer: true,
}

function issues(result: {
  success: boolean
  error?: { issues: { path: PropertyKey[] }[] }
}) {
  return (result.error?.issues ?? []).map((i) => i.path.join("."))
}

describe("alta de jugador", () => {
  it("el nombre es obligatorio y no puede estar vacío", () => {
    expect(
      issues(createPlayerSchema.safeParse({ phone: base.phone }))
    ).toContain("name")
    expect(
      issues(createPlayerSchema.safeParse({ ...base, name: "   " }))
    ).toContain("name")
    expect(
      createPlayerSchema.parse({ ...base, name: "  Juan   Pérez  " }).name
    ).toBe("Juan Pérez")
  })

  it("el teléfono es obligatorio y se normaliza a E.164 (con país detectado)", () => {
    expect(issues(createPlayerSchema.safeParse({ name: base.name }))).toContain(
      "phone"
    )
    expect(
      issues(createPlayerSchema.safeParse({ ...base, phone: "" }))
    ).toContain("phone")
    expect(createPlayerSchema.parse(base)).toMatchObject({
      phone: "+528711234567",
      countryCode: "MX",
    })
  })

  it("acepta internacionales y rechaza inválidos", () => {
    expect(
      createPlayerSchema.parse({ ...base, phone: "+34 612 345 678" })
    ).toMatchObject({
      phone: "+34612345678",
      countryCode: "ES",
    })
    expect(
      issues(createPlayerSchema.safeParse({ ...base, phone: "12345" }))
    ).toContain("phone")
    expect(
      issues(createPlayerSchema.safeParse({ ...base, phoneCountry: "ZZ" }))
    ).toContain("phoneCountry")
  })

  it("no duplica +52 si el usuario ya escribió el prefijo", () => {
    expect(
      createPlayerSchema.parse({ ...base, phone: "+52 871 123 4567" }).phone
    ).toBe("+528711234567")
  })

  it("el apodo y las notas son opcionales (vacío → null)", () => {
    const parsed = createPlayerSchema.parse({
      ...base,
      nickname: "  ",
      notes: "",
    })
    expect(parsed.nickname).toBeNull()
    expect(parsed.notes).toBeNull()
  })

  it("el consentimiento está ausente (desmarcado) por defecto", () => {
    expect(createPlayerSchema.parse(base).whatsappConsent).toBeUndefined()
  })

  it("no acepta campos de crédito, deuda, estado ni id", () => {
    for (const extra of [
      { creditLimit: "1" },
      { currentDebt: "0" },
      { isActive: false },
      { id: "x" },
    ]) {
      expect(createPlayerSchema.safeParse({ ...base, ...extra }).success).toBe(
        false
      )
    }
  })

  it("las notas eliminan caracteres de control y respetan el máximo", () => {
    expect(
      createPlayerSchema.parse({ ...base, notes: "Hola\u0000 mundo\nlínea 2" })
        .notes
    ).toBe("Hola mundo\nlínea 2")
    expect(
      createPlayerSchema.safeParse({ ...base, notes: "x".repeat(1001) }).success
    ).toBe(false)
  })
})

describe("edición", () => {
  it("normaliza el teléfono nuevo y exige al menos un campo", () => {
    expect(updatePlayerSchema.parse({ phone: "871 765 4321" }).phone).toBe(
      "+528717654321"
    )
    expect(updatePlayerSchema.safeParse({}).success).toBe(false)
    expect(updatePlayerSchema.safeParse({ phoneCountry: "US" }).success).toBe(
      false
    )
  })

  it("no permite cambiar estado, deudas ni fechas", () => {
    for (const body of [
      { isActive: false },
      { currentBalance: "0" },
      { createdAt: "x" },
    ]) {
      expect(updatePlayerSchema.safeParse(body).success).toBe(false)
    }
  })
})

describe("consentimiento WhatsApp", () => {
  it("otorgar exige confirmación del jugador y la versión vigente del aviso", () => {
    expect(consentActionSchema.safeParse(grant).success).toBe(true)
    expect(
      consentActionSchema.safeParse({ ...grant, confirmedByPlayer: false })
        .success
    ).toBe(false)
    expect(
      consentActionSchema.safeParse({ ...grant, noticeVersion: "vieja" })
        .success
    ).toBe(false)
  })

  it("revocar no requiere aviso y es un registro independiente", () => {
    expect(
      consentActionSchema.parse({ action: "REVOKED", source: "IN_PERSON" })
    ).toMatchObject({
      action: "REVOKED",
    })
  })

  it("el consentimiento vigente se deriva del último registro y del teléfono actual", () => {
    const at = new Date("2026-10-01T00:00:00Z")
    const phone = "+528711234567"
    expect(deriveConsentStatus(phone, undefined)).toMatchObject({
      granted: false,
      lastAction: null,
    })
    expect(
      deriveConsentStatus(phone, {
        action: "GRANTED",
        phone,
        noticeVersion: "v1",
        recordedAt: at,
      })
    ).toMatchObject({ granted: true })
    expect(
      deriveConsentStatus(phone, {
        action: "REVOKED",
        phone,
        noticeVersion: "v1",
        recordedAt: at,
      })
    ).toMatchObject({ granted: false, lastAction: "REVOKED" })
    expect(
      deriveConsentStatus(phone, {
        action: "GRANTED",
        phone: "+528710000000",
        noticeVersion: "v1",
        recordedAt: at,
      })
    ).toMatchObject({ granted: false, staleBecausePhoneChanged: true })
  })
})

describe("estado del jugador", () => {
  it("un jugador activo es seleccionable; uno inactivo no puede usarse en operaciones nuevas", () => {
    expect(isPlayerSelectable({ isActive: true })).toBe(true)
    expect(() =>
      assertPlayerSelectable({ isActive: true, name: "Ana" })
    ).not.toThrow()
    expect(isPlayerSelectable({ isActive: false })).toBe(false)
    expect(() =>
      assertPlayerSelectable({ isActive: false, name: "Ana" })
    ).toThrow(BusinessRuleError)
  })

  it("el listado filtra por estado y por defecto incluye todos", () => {
    expect(listPlayersQuerySchema.parse({}).status).toBe("all")
    expect(
      listPlayersQuerySchema.safeParse({ status: "deleted" }).success
    ).toBe(false)
  })
})

describe("política de crédito", () => {
  it("no hay límite individual ni global, ni autorización externa", () => {
    expect(CREDIT_POLICY.individualLimit).toBeNull()
    expect(CREDIT_POLICY.globalLimit).toBeNull()
    expect(CREDIT_POLICY.requiresExternalApproval).toBe(false)
    expect(CREDIT_POLICY.grantableBy).toEqual([
      "SUPERADMIN",
      "PARTNER",
      "CASHIER",
    ])
    expect(CREDIT_POLICY.requiresSignature).toBe(true)
    expect(CREDIT_POLICY.creditCountsAsCash).toBe(false)
    expect(isWithinCreditPolicy()).toBe(true)
  })
})
