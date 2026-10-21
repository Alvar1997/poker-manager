import { createHash } from "node:crypto"

import { Prisma } from "@/generated/prisma/client"

/**
 * Cálculos puros del inventario (sin base de datos). Los totales que se
 * muestran o guardan los calcula SIEMPRE el servidor con estas funciones.
 *
 *   disponible       = bajo custodia − reservadas
 *   inventario activo = bajo custodia + en circulación
 *   (las reservadas YA están dentro de la custodia: no se suman aparte)
 */

export type QuantityBreakdown = {
  custody: number
  reserved: number
  circulation: number
  retired: number
}

export function availableQuantity(
  b: Pick<QuantityBreakdown, "custody" | "reserved">
): number {
  if (b.reserved > b.custody) {
    throw new Error("Inconsistencia: reservadas mayor que custodia")
  }
  return b.custody - b.reserved
}

export function activeInventory(
  b: Pick<QuantityBreakdown, "custody" | "circulation">
): number {
  return b.custody + b.circulation
}

/** Valor nominal (no es dinero en caja): cantidad × valor de la ficha. */
export function nominalValue(
  quantity: number,
  unitValue: Prisma.Decimal | string
): Prisma.Decimal {
  if (!Number.isInteger(quantity)) throw new Error("Cantidad no entera")
  return new Prisma.Decimal(unitValue).mul(quantity)
}

export function sumDecimals(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((acc, v) => acc.add(v), new Prisma.Decimal(0))
}

/** Diferencia de arqueo: contado − esperado (negativo = faltante). */
export function countDifference(expected: number, counted: number): number {
  return counted - expected
}

/** Cambio firmado en la custodia que produce un ajuste. */
export function adjustmentDelta(
  kind: "SHORTAGE" | "SURPLUS" | "CORRECTION",
  quantity: number,
  direction?: "INCREASE" | "DECREASE"
): number {
  if (kind === "SHORTAGE") return -quantity
  if (kind === "SURPLUS") return quantity
  if (!direction) throw new Error("La corrección requiere dirección")
  return direction === "INCREASE" ? quantity : -quantity
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    )
  }
  return value
}

/**
 * Huella del contenido de una solicitud (sin la clave de idempotencia).
 * Misma clave con distinta huella = reutilización indebida → 409.
 */
export function requestHash(payload: Record<string, unknown>): string {
  const { idempotencyKey: _ignored, ...rest } = payload
  void _ignored
  return createHash("sha256")
    .update(JSON.stringify(canonical(rest)))
    .digest("hex")
}

/**
 * Importe nominal de una compra/recompra/devolución (solo importe, sin
 * desglose por denominación): Decimal > 0 con máximo 2 decimales.
 */
export function parseNominalAmount(
  value: Prisma.Decimal | string
): Prisma.Decimal {
  let amount: Prisma.Decimal
  try {
    amount = new Prisma.Decimal(value)
  } catch {
    throw new Error("Importe inválido")
  }
  if (!amount.isFinite() || !amount.greaterThan(0))
    throw new Error("El importe de fichas debe ser mayor que cero")
  if (!amount.equals(amount.toDecimalPlaces(2)))
    throw new Error("El importe admite como máximo dos decimales")
  return amount
}

/** Disponible nominal = custodia − reservado (lo reservado sigue físicamente en custodia). */
export function nominalAvailable(
  custody: Prisma.Decimal,
  reserved: Prisma.Decimal
): Prisma.Decimal {
  return custody.sub(reserved)
}
