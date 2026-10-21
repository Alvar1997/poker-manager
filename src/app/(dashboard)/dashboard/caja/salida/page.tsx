import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { currentSessionGateway } from "@/modules/cash/session-gateway"
import { CASH_BASE } from "@/modules/cash/components/format"
import { NoSessionNotice } from "@/modules/cash/components/no-session-notice"

import { BackToCash } from "../back-link"

export const metadata = { title: "Salida de efectivo — Poker Manager" }

export default async function Page() {
  await requirePagePermission(PERMISSIONS.CASH_OPERATE, `${CASH_BASE}/salida`)
  const session = await currentSessionGateway().getOpenSession()
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackToCash />
      <h1 className="text-xl font-semibold">Salida de efectivo</h1>
      {session ? null : (
        <NoSessionNotice>
          Los retiros se registran dentro de una sesión abierta. El formulario
          se habilita con el Módulo 06 (sesiones).
        </NoSessionNotice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Reglas</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              Un retiro nunca puede ser mayor al efectivo disponible; el sistema
              indica el faltante.
            </li>
            <li>
              Destinos permitidos: entrega a propietario/socio, resguardo y
              devolución de aportación.
            </li>
            <li data-testid="no-expenses">
              La caja no registra gastos operativos (comida, bebidas, insumos,
              servicios, transporte…).
            </li>
            <li>
              El traslado de efectivo al banco queda en tránsito hasta
              verificarse en la cuenta.
            </li>
            <li>
              El retiro total del cierre se hace desde el cierre de sesión
              (Módulo 12).
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
