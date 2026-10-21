"use client"

import { useCallback, useState } from "react"

/**
 * Una clave por INTENTO lógico de operación: se conserva mientras el
 * usuario reintenta (doble clic, red caída) y se renueva tras un éxito.
 * La garantía real está en el servidor (clave única en la base).
 */
export function useIdempotencyKey() {
  const [key, setKey] = useState(() => crypto.randomUUID())
  const renew = useCallback(() => setKey(crypto.randomUUID()), [])
  return [key, renew] as const
}
