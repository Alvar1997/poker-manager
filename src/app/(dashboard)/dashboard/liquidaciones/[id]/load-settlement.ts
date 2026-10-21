import { notFound } from "next/navigation"

import { NotFoundError } from "@/lib/errors"
import { getSettlement } from "@/modules/settlements/settlement.service"

/** Carga la liquidación de la ruta (404 si el id no es válido o no existe). */
export async function loadSettlement(id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  return getSettlement(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
}
