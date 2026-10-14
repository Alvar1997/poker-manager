import { ChevronLeft, ChevronRight, Plus, UsersRound } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { PlayerFilters } from "@/modules/players/components/player-filters"
import { listPlayersQuerySchema } from "@/modules/players/player.schemas"
import { listPlayers } from "@/modules/players/player.service"

export const metadata = { title: "Jugadores — Poker Manager" }

const PAGE_SIZE = 20

export default async function PlayersPage({
  searchParams,
}: PageProps<"/dashboard/jugadores">) {
  const user = await requirePagePermission(
    PERMISSIONS.PLAYERS_READ,
    "/dashboard/jugadores"
  )
  const raw = await searchParams
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const sort = str(raw.sort)
  const parsed = listPlayersQuerySchema.safeParse({
    q: str(raw.q),
    status: str(raw.status),
    sort,
    order: sort && sort !== "name" ? "desc" : "asc",
    page: str(raw.page),
    pageSize: PAGE_SIZE,
  })
  const query = parsed.success
    ? parsed.data
    : listPlayersQuerySchema.parse({ pageSize: PAGE_SIZE })
  const result = await listPlayers(query)

  const pageHref = (page: number) => {
    const params = new URLSearchParams()
    if (query.q) params.set("q", query.q)
    if (query.status !== "all") params.set("status", query.status)
    if (query.sort !== "name") params.set("sort", query.sort)
    params.set("page", String(page))
    return `/dashboard/jugadores?${params.toString()}`
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Jugadores</h1>
          <p
            className="text-muted-foreground text-sm"
            data-testid="players-total"
          >
            {result.total} {result.total === 1 ? "jugador" : "jugadores"}
          </p>
        </div>
        {can(user, PERMISSIONS.PLAYERS_CREATE) ? (
          <Link
            href="/dashboard/jugadores/nuevo"
            className={cn(buttonVariants(), "h-11 md:h-9")}
          >
            <Plus />
            Nuevo jugador
          </Link>
        ) : null}
      </div>

      <PlayerFilters
        values={{ q: query.q ?? "", status: query.status, sort: query.sort }}
      />

      {result.items.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title={
            query.q || query.status !== "all"
              ? "Sin resultados"
              : "Aún no hay jugadores"
          }
          description={
            query.q || query.status !== "all"
              ? "Ningún jugador coincide con la búsqueda o el filtro."
              : "Registra al primer jugador con el botón Nuevo jugador."
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {result.items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/jugadores/${p.id}`}
                className="block h-full rounded-xl"
                data-testid="player-card"
              >
                <Card className="hover:bg-muted/50 h-full transition-colors">
                  <CardContent className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{p.name}</p>
                        {p.nickname ? (
                          <p className="text-muted-foreground truncate text-sm">
                            “{p.nickname}”
                          </p>
                        ) : null}
                      </div>
                      <ActiveBadge isActive={p.isActive} />
                    </div>
                    <p className="text-sm tabular-nums">{p.phoneDisplay}</p>
                    <p className="text-muted-foreground text-xs">
                      Registrado el {formatDate(p.createdAt)}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav
          aria-label="Paginación"
          className="flex items-center justify-between gap-2"
        >
          {result.page > 1 ? (
            <Link
              href={pageHref(result.page - 1)}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 md:h-9"
              )}
            >
              <ChevronLeft />
              Anterior
            </Link>
          ) : (
            <span />
          )}
          <span
            className="text-muted-foreground text-sm"
            data-testid="players-page"
          >
            Página {result.page} de {result.totalPages}
          </span>
          {result.page < result.totalPages ? (
            <Link
              href={pageHref(result.page + 1)}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 md:h-9"
              )}
            >
              Siguiente
              <ChevronRight />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  )
}
