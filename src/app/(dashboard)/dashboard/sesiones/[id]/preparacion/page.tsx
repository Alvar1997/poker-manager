import { redirect } from "next/navigation"

import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

/** La preparación ahora es el asistente de apertura (4 pasos). */
export default async function PreparationPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/preparacion">) {
  const { id } = await params
  redirect(`${SESSIONS_BASE}/${encodeURIComponent(id)}/apertura`)
}
