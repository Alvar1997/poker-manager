import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { phoneCountryOptions } from "@/lib/phone"
import { PlayerForm } from "@/modules/players/components/player-form"

export const metadata = { title: "Nuevo jugador — Poker Manager" }

export default async function NewPlayerPage() {
  await requirePagePermission(
    PERMISSIONS.PLAYERS_CREATE,
    "/dashboard/jugadores/nuevo"
  )

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href="/dashboard/jugadores"
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Jugadores
      </Link>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Nuevo jugador
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Las opciones de país se calculan en el servidor para evitar
              diferencias de Intl entre servidor y navegador al hidratar. */}
          <PlayerForm countries={phoneCountryOptions()} />
        </CardContent>
      </Card>
    </div>
  )
}
