import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max"

/**
 * Teléfonos de jugadores: validación y normalización a E.164 con
 * libphonenumber-js (metadatos completos `max`: valida estructura y
 * longitud por país y tipo de número, no solo la longitud).
 *
 * - México es el país predeterminado: "871 123 4567" → "+528711234567".
 * - Si el usuario escribe un prefijo internacional ("+34…", "0034…") se
 *   respeta; nunca se antepone +52 a ciegas.
 * - Compatibilidad: el antiguo "1" de celulares mexicanos ("+52 1 871…",
 *   eliminado en 2019) se descarta si el número resultante es válido.
 * - Validar el formato NO demuestra que el jugador sea dueño del número.
 *
 * Puro: lo usan tanto los formularios como el servidor (que siempre vuelve
 * a normalizar; la validación del cliente es solo UX).
 */

export const DEFAULT_PHONE_COUNTRY: CountryCode = "MX"

export type NormalizedPhone = {
  /** Formato E.164, el que se guarda: +528711234567 */
  e164: string
  /** País detectado (ISO 3166-1 alfa-2). */
  country: CountryCode
}

export function isSupportedCountry(value: string): value is CountryCode {
  return (getCountries() as string[]).includes(value)
}

export function normalizePhone(
  input: string,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY
): NormalizedPhone | null {
  const raw = input.trim()
  if (!raw) return null
  // "00" es el prefijo de marcación internacional en México y otros países.
  const text = raw.startsWith("00") ? `+${raw.slice(2)}` : raw

  const parsed = parsePhoneNumberFromString(text, defaultCountry)
  if (parsed?.isValid() && parsed.country) {
    return { e164: parsed.number, country: parsed.country }
  }

  // Celular mexicano con el "1" histórico tras +52.
  if (
    parsed &&
    parsed.countryCallingCode === "52" &&
    /^1\d{10}$/.test(parsed.nationalNumber)
  ) {
    const legacy = parsePhoneNumberFromString(
      `+52${parsed.nationalNumber.slice(1)}`
    )
    if (legacy?.isValid() && legacy.country) {
      return { e164: legacy.number, country: legacy.country }
    }
  }

  return null
}

/** "+52 871 123 4567" para mostrar en pantalla. */
export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164
}

/** "+52 •••• 4567": para auditoría y mensajes donde basta identificarlo. */
export function maskPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164)
  const last4 = e164.slice(-4)
  return parsed
    ? `+${parsed.countryCallingCode} •••• ${last4}`
    : `•••• ${last4}`
}

export type PhoneCountryOption = {
  code: CountryCode
  name: string
  callingCode: string
}

/** Países para el selector, en español, con México primero. */
export function phoneCountryOptions(locale = "es-MX"): PhoneCountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" })
  const options = getCountries().map((code) => ({
    code,
    name: names.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  options.sort((a, b) => a.name.localeCompare(b.name, locale))
  const mx = options.findIndex((o) => o.code === DEFAULT_PHONE_COUNTRY)
  return [options[mx], ...options.slice(0, mx), ...options.slice(mx + 1)]
}
