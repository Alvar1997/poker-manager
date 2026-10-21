import { createHash } from "node:crypto"

/**
 * Serialización CANÓNICA: claves ordenadas recursivamente, sin depender del
 * orden en que se construyó el objeto. Los importes deben llegar como
 * strings decimales ("5000.00"), nunca como números de punto flotante.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])])
    )
  }
  if (typeof value === "number" && !Number.isInteger(value))
    throw new Error(
      "Valor no entero en contenido canónico: usa strings decimales"
    )
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** SHA-256 del JSON canónico. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
