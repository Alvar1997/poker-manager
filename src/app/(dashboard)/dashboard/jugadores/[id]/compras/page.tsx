import { notFound } from "next/navigation"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { PurchaseList } from "@/modules/purchases/components/purchase-ui"
import { listPurchases } from "@/modules/purchases/purchase.service"
import { getPlayer } from "@/modules/players/player.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Compras del jugador — Poker Manager" }

export default async function PlayerPurchasesPage({
  params,
}: PageProps<"/dashboard/jugadores/[id]/compras">) {
  const { id } = await params
  await requirePagePermission(
    PERMISSIONS.PURCHASES_READ,
    "/dashboard/jugadores"
  )
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const player = await getPlayer(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const result = await listPurchases({ playerId: id, page: 1, pageSize: 100 })
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink href={`/dashboard/jugadores/${id}`} label={player.name} />
      <h1 className="text-xl font-semibold">Compras · {player.name}</h1>
      <PurchaseList items={result.items} showPlayer={false} />
    </div>
  )
}
