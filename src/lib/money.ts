import { z } from "zod"

/**
 * Montos monetarios. Regla del proyecto: nunca `number`/Float para dinero.
 * La API recibe y devuelve montos como STRING decimal ("25", "25.50"); el
 * servidor los guarda como Prisma.Decimal (Prisma acepta el string tal
 * cual) y compara con Prisma.Decimal. Este archivo es puro: lo usan
 * también los formularios del navegador.
 */

const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/

/** Monto > 0 con hasta 2 decimales, como string. */
export const positiveMoneySchema = z
  .string({ message: "Ingresa un monto" })
  .trim()
  .regex(MONEY_PATTERN, "Monto inválido (hasta 2 decimales, sin signos)")
  // Con el patrón anterior, "> 0" equivale a "contiene algún dígito 1-9".
  .refine((value) => /[1-9]/.test(value), {
    message: "El monto debe ser mayor que cero",
  })

/** Serializa un Decimal a string con 2 decimales ("25.00"). */
export function moneyToString(value: { toFixed(digits: number): string }) {
  return value.toFixed(2)
}
