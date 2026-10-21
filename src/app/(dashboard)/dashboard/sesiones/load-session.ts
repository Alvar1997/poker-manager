import "server-only"

import { notFound } from "next/navigation"

import { NotFoundError } from "@/lib/errors"
import { getSession } from "@/modules/sessions/session.service"

export async function loadSession(
  id: string,
  viewer: { id: string; role: string }
) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  return getSession(id, viewer).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
}
