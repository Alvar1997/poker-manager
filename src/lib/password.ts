import "server-only"

import { randomInt } from "node:crypto"

import bcrypt from "bcryptjs"

/**
 * Hash y verificación de contraseñas, y generación de credenciales
 * temporales. Las reglas de la política (longitud, etc.) viven en
 * src/modules/auth/auth.schemas.ts para poder validarse también en el
 * cliente.
 */

const BCRYPT_COST = 12

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST)
}

export function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash)
}

let dummyHash: Promise<string> | undefined

/**
 * Compara contra un hash descartable para que una cuenta inexistente o
 * desactivada tarde lo mismo que una contraseña incorrecta (evita
 * enumerar cuentas midiendo tiempos de respuesta).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= bcrypt.hash("poker-manager-timing-equalizer", BCRYPT_COST)
  await bcrypt.compare(password, await dummyHash)
}

// Sin caracteres ambiguos (0/O, 1/l/I) para dictarla o copiarla a mano.
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"

/**
 * Contraseña temporal criptográficamente aleatoria: 4 bloques de 5
 * caracteres (~114 bits). Se muestra una sola vez al SUPERADMIN y el
 * usuario debe cambiarla en su primer acceso (mustChangePassword).
 */
export function generateTemporaryPassword(): string {
  const blocks = Array.from({ length: 4 }, () =>
    Array.from(
      { length: 5 },
      () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]
    ).join("")
  )
  return blocks.join("-")
}
