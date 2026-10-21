import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { currentSessionGateway } from "@/modules/cash/session-gateway"
import { CASH_BASE } from "@/modules/cash/components/format"
import { NoSessionNotice } from "@/modules/cash/components/no-session-notice"

import { BackToCash } from "../../back-link"

export const metadata = { title: "Nuevo arqueo de efectivo — Poker Manager" }

export default async function Page() {
  await requirePagePermission(
    PERMISSIONS.CASH_OPERATE,
    `${CASH_BASE}/conciliaciones/nueva`
  )
  const session = await currentSessionGateway().getOpenSession()
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackToCash />
      <h1 className="text-xl font-semibold">Nuevo arqueo de efectivo</h1>
      {session ? null : (
        <NoSessionNotice>
          El arqueo de efectivo pertenece a una sesión. Se habilita al preparar
          o abrir una sesión (Módulo 06).
        </NoSessionNotice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Reglas</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              Apertura: el efectivo esperado es $0.00. Si aparece dinero, se
              retira y se vuelve a contar; nunca se convierte en fondo.
            </li>
            <li>
              Control y cierre: se compara el efectivo contado contra el
              registrado.
            </li>
            <li>
              Contar no modifica saldos. Una diferencia exige explicación y, si
              procede, un ajuste explícito y auditado.
            </li>
            <li>
              La sesión no se habilita sin el arqueo de fichas vigente de cada
              juego que se use.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
