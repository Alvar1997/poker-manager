import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  CREDITS_BASE,
  PaymentList,
} from "@/modules/credits/components/credit-ui"
import { listPayments } from "@/modules/credits/receivable-payment.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Abonos administrativos — Poker Manager" }

export default async function AdministrativePaymentsPage() {
  await requirePagePermission(PERMISSIONS.CREDITS_READ, CREDITS_BASE)
  const result = await listPayments({
    origin: "ADMINISTRATIVE",
    page: 1,
    pageSize: 100,
  })
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink href={CREDITS_BASE} label="Créditos" />
      <h1 className="text-xl font-semibold">Abonos administrativos</h1>
      <p className="text-muted-foreground text-sm">
        Recibidos fuera de sesión. Nunca modifican la caja de una sesión
        cerrada: el efectivo queda en custodia y las transferencias y terminales
        van al banco o a cobros por liquidar.
      </p>
      <PaymentList items={result.items} />
    </div>
  )
}
