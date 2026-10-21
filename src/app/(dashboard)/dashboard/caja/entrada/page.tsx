import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { currentSessionGateway } from "@/modules/cash/session-gateway"
import { CASH_BASE } from "@/modules/cash/components/format"
import { NoSessionNotice } from "@/modules/cash/components/no-session-notice"

import { BackToCash } from "../back-link"

export const metadata = { title: "Entrada de efectivo — Poker Manager" }

export default async function Page() {
  await requirePagePermission(PERMISSIONS.CASH_OPERATE, `${CASH_BASE}/entrada`)
  const session = await currentSessionGateway().getOpenSession()
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <BackToCash />
      <h1 className="text-xl font-semibold">Entrada de efectivo</h1>
      {session ? null : (
        <NoSessionNotice>
          Las aportaciones se registran dentro de una sesión abierta. El
          formulario se habilita con el Módulo 06 (sesiones).
        </NoSessionNotice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Reglas</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              Una aportación es dinero real entregado a la caja: no es compra,
              ingreso, ganancia ni deuda.
            </li>
            <li>
              Se registra quién aporta, el importe, el motivo y quién la
              capturó; queda auditada.
            </li>
            <li>
              Los cobros de compras y abonos entran desde sus propios módulos,
              no desde aquí.
            </li>
            <li>La caja abre siempre en $0.00: no existe fondo inicial.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
