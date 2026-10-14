import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { phoneCountryOptions } from "@/lib/phone"
import { PlayerForm } from "@/modules/players/components/player-form"
import { playerIdSchema } from "@/modules/players/player.schemas"
import { getPlayer } from "@/modules/players/player.service"

export const metadata = { title: "Editar jugador — Poker Manager" }

export default async function EditPlayerPage({
  params,
}: PageProps<"/dashboard/jugadores/[id]/editar">) {
  await requirePagePermission(
    PERMISSIONS.PLAYERS_UPDATE,
    "/dashboard/jugadores/[id]/editar"
  )
  const { id } = await params
  if (!playerIdSchema.safeParse(id).success) notFound()
  const player = await getPlayer(id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound()
    throw error
  })

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href={`/dashboard/jugadores/${player.id}`}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {player.name}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Editar jugador
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            El estado y el consentimiento de WhatsApp se gestionan desde el
            perfil.
          </p>
        </CardHeader>
        <CardContent>
          <PlayerForm countries={phoneCountryOptions()} player={player} />
        </CardContent>
      </Card>
    </div>
  )
}
