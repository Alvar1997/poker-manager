import "server-only"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { BusinessRuleError } from "@/lib/errors"
import { getEnv } from "@/lib/env"

/**
 * Cifrado simétrico de datos sensibles en reposo (número de cuenta, CLABE)
 * con AES-256-GCM. Formato: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * La clave vive solo en SETTINGS_ENCRYPTION_KEY, nunca en la base.
 */

const VERSION = "v1"

function key(): Buffer {
  const raw = getEnv().SETTINGS_ENCRYPTION_KEY
  if (!raw) {
    throw new BusinessRuleError(
      "Falta configurar SETTINGS_ENCRYPTION_KEY en el servidor para guardar datos bancarios"
    )
  }
  return Buffer.from(raw, "base64")
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url")
    )
    .join(".")
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".")
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Formato de dato cifrado inválido")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url")
  )
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
