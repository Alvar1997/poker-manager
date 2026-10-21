import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { CreateSessionButton } from "@/modules/sessions/components/session-actions"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../back-link"

export const metadata = { title: "Nueva sesión — Poker Manager" }

export default async function NewSessionPage() {
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_MANAGE,
    `${SESSIONS_BASE}/nueva`
  )
  return (
    <div className="mx-auto max-w-md space-y-4">
      <BackLink href={SESSIONS_BASE} label="Sesiones" />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Nueva sesión
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="text-muted-foreground list-disc space-y-1 pl-5">
            <li>
              El folio y la responsable ({user.name}) los asigna el sistema.
            </li>
            <li>
              No se selecciona mesa: las mesas se abren cuando la sesión ya esté
              abierta.
            </li>
            <li>No hay fondo inicial: la caja abre en $0.00.</li>
            <li>
              Para abrirla deberás contar el inventario de fichas y confirmar la
              caja en $0.00.
            </li>
          </ul>
          <CreateSessionButton />
        </CardContent>
      </Card>
    </div>
  )
}
