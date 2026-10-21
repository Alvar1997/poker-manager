import { notFound } from "next/navigation"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { PurchaseList } from "@/modules/purchases/components/purchase-ui"
import { listPurchases } from "@/modules/purchases/purchase.service"
import { getSessionTableDetail } from "@/modules/session-tables/session-table.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../../../back-link"
import { loadSession } from "../../../../load-session"

export const metadata = { title: "Compras de la mesa — Poker Manager" }

/** Compras registradas en esta mesa (conservan su mesa aunque el jugador se cambie). */
export default async function TablePurchasesPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/mesas/[tableId]/compras">) {
  const { id, tableId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASES_READ,
    `${SESSIONS_BASE}/${id}/mesas`
  )
  await loadSession(id, user)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) notFound()
  const table = await getSessionTableDetail(id, tableId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const result = await listPurchases({
    sessionId: id,
    tableId,
    page: 1,
    pageSize: 100,
  })
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/mesas/${tableId}`}
        label={table.name}
      />
      <h1 className="text-xl font-semibold">Compras · {table.name}</h1>
      <p className="text-muted-foreground text-sm">
        {result.total} compra{result.total === 1 ? "" : "s"} registrada
        {result.total === 1 ? "" : "s"} en esta mesa. El inventario y la caja
        son compartidos por ambas mesas.
      </p>
      <PurchaseList items={result.items} showTable={false} />
    </div>
  )
}
