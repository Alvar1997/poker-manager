import { Users } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import { CREDITS_BASE } from "@/modules/credits/components/credit-ui"
import { listPlayersWithDebt } from "@/modules/credits/receivable.service"

import { BackLink } from "../../sesiones/back-link"

export const metadata = { title: "Jugadores con deuda — Poker Manager" }

export default async function DebtorsPage({
  searchParams,
}: PageProps<"/dashboard/creditos/jugadores">) {
  await requirePagePermission(PERMISSIONS.CREDITS_READ, CREDITS_BASE)
  const sp = await searchParams
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 80) : ""
  const players = await listPlayersWithDebt(q || undefined)
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink href={CREDITS_BASE} label="Créditos" />
      <h1 className="text-xl font-semibold">Jugadores con deuda</h1>
      <form method="get" className="flex gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre o apodo"
          aria-label="Buscar jugador"
          className="h-11 md:h-9"
        />
        <Button type="submit" variant="outline" className="h-11 md:h-9">
          Buscar
        </Button>
      </form>
      {players.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin deudas pendientes"
          description="Los jugadores con saldo por pagar aparecerán aquí."
        />
      ) : (
        <ul className="space-y-2" data-testid="debtor-list">
          {players.map((p) => (
            <li key={p.player.id}>
              <Link
                href={`${CREDITS_BASE}/jugadores/${p.player.id}`}
                className="block"
              >
                <Card className="hover:bg-muted/40" data-testid="debtor-row">
                  <CardContent className="flex items-center justify-between gap-2 text-sm">
                    <div>
                      <p className="font-medium">
                        {p.player.name}
                        {p.player.nickname ? ` · ${p.player.nickname}` : ""}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {p.openCount} crédito{p.openCount === 1 ? "" : "s"} ·
                        más antiguo{" "}
                        {p.oldestAt ? formatDateTime(p.oldestAt) : "—"}
                      </p>
                    </div>
                    <span className="text-base font-semibold tabular-nums">
                      {formatMXN(p.outstanding)}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
