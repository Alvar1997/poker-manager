import { CalendarClock, ChevronLeft, ChevronRight, Plus } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { NativeSelect } from "@/components/shared/native-select"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { formatBusinessDateMx } from "@/modules/sessions/session-folio"
import { cn } from "@/lib/utils"
import {
  SESSIONS_BASE,
  SessionStatusBadge,
} from "@/modules/sessions/components/session-ui"
import { sessionsQuerySchema } from "@/modules/sessions/session.schemas"
import {
  getActiveSession,
  listSessions,
} from "@/modules/sessions/session.service"
import {
  SESSION_STATUS_LABEL,
  SESSION_STATUSES,
} from "@/modules/sessions/session.state"

export const metadata = { title: "Sesiones — Poker Manager" }

const FILTERS = ["status", "kind", "q", "from", "to", "sort"] as const

export default async function SessionsPage({
  searchParams,
}: PageProps<"/dashboard/sesiones">) {
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    SESSIONS_BASE
  )
  const raw = await searchParams
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const parsed = sessionsQuerySchema.safeParse({
    ...Object.fromEntries(FILTERS.map((k) => [k, str(raw[k])])),
    page: str(raw.page),
  })
  const query = parsed.success ? parsed.data : sessionsQuerySchema.parse({})
  const [result, active] = await Promise.all([
    listSessions(query, user),
    getActiveSession(user),
  ])
  const canManage = can(user, PERMISSIONS.SESSIONS_MANAGE)
  const href = (page: number) => {
    const p = new URLSearchParams()
    for (const k of FILTERS) if (query[k]) p.set(k, String(query[k]))
    p.set("page", String(page))
    return `${SESSIONS_BASE}?${p}`
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Sesiones</h1>
        {canManage && !active ? (
          <Link
            href={`${SESSIONS_BASE}/nueva`}
            className={cn(buttonVariants(), "h-11 md:h-9")}
            data-testid="new-session-link"
          >
            <Plus />
            Nueva sesión
          </Link>
        ) : active && can(user, PERMISSIONS.SESSIONS_HISTORICAL_CREATE) ? (
          // La captura histórica no ocupa la sesión vigente.
          <Link
            href={`${SESSIONS_BASE}/nueva?historica=1`}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-11 md:h-9"
            )}
            data-testid="new-historical-session-link"
          >
            <Plus />
            Registrar sesión histórica
          </Link>
        ) : null}
      </div>

      {active ? (
        <Link
          href={`${SESSIONS_BASE}/${active.id}`}
          className="block rounded-xl"
          data-testid="active-session"
        >
          <Card className="border-primary/40 hover:bg-muted/50 transition-colors">
            <CardContent className="space-y-1">
              <p className="text-muted-foreground text-xs">Sesión vigente</p>
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-lg font-semibold">
                  {active.folio}
                </p>
                <SessionStatusBadge status={active.status} />
              </div>
              <p className="text-muted-foreground text-xs">
                Creada por {active.createdBy.name} ·{" "}
                {formatDateTime(active.createdAt)}
                {active.openedAt
                  ? ` · abierta ${formatDateTime(active.openedAt)}`
                  : ""}
              </p>
            </CardContent>
          </Card>
        </Link>
      ) : null}

      <form
        method="get"
        action={SESSIONS_BASE}
        className="grid grid-cols-2 gap-2 md:grid-cols-3"
        aria-label="Filtros"
      >
        <Input
          name="q"
          placeholder="Folio"
          defaultValue={query.q ?? ""}
          aria-label="Folio"
          className="h-11 md:h-9"
        />
        <NativeSelect
          name="status"
          defaultValue={query.status ?? ""}
          aria-label="Estado"
        >
          <option value="">Todos los estados</option>
          {SESSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SESSION_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="kind"
          defaultValue={query.kind ?? ""}
          aria-label="Tipo"
          data-testid="filter-kind"
        >
          <option value="">Normales e históricas</option>
          <option value="regular">Solo normales</option>
          <option value="historical">Solo históricas</option>
        </NativeSelect>
        <NativeSelect name="sort" defaultValue={query.sort} aria-label="Orden">
          <option value="desc">Más recientes</option>
          <option value="asc">Más antiguas</option>
        </NativeSelect>
        <Input
          type="date"
          name="from"
          defaultValue={query.from ?? ""}
          aria-label="Fecha operativa desde"
          title="Fecha operativa desde"
          data-testid="filter-from"
          className="h-11 md:h-9"
        />
        <Input
          type="date"
          name="to"
          defaultValue={query.to ?? ""}
          aria-label="Fecha operativa hasta"
          title="Fecha operativa hasta"
          data-testid="filter-to"
          className="h-11 md:h-9"
        />
        <Button type="submit" variant="secondary" className="h-11 md:h-9">
          Filtrar
        </Button>
      </form>

      {result.items.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Sin sesiones"
          description="Todavía no hay sesiones con estos filtros."
        />
      ) : (
        <ul className="space-y-2" data-testid="session-list">
          {result.items.map((s) => (
            <li key={s.id}>
              <Link
                href={`${SESSIONS_BASE}/${s.id}`}
                className="block rounded-xl"
                data-testid="session-row"
              >
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-medium">{s.folio}</span>
                      <SessionStatusBadge status={s.status} />
                    </div>
                    <p
                      className="text-xs"
                      data-testid="session-row-business-date"
                    >
                      Fecha operativa{" "}
                      <strong>{formatBusinessDateMx(s.businessDate)}</strong>
                      {s.isHistorical ? " · histórica" : ""}
                      {s.previousFolio ? ` · antes ${s.previousFolio}` : ""}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Registrada {formatDateTime(s.createdAt)} por{" "}
                      {s.createdBy.name}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {s.openedAt
                        ? `Apertura ${formatDateTime(s.openedAt)}`
                        : s.isHistorical
                          ? "Captura histórica (sin operación en vivo)"
                          : "Sin apertura"}
                      {s.closedAt
                        ? ` · Cierre ${formatDateTime(s.closedAt)}`
                        : ""}
                      {s.cancelledAt
                        ? ` · Cancelada ${formatDateTime(s.cancelledAt)}`
                        : ""}
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
          className="flex items-center justify-between"
        >
          {result.page > 1 ? (
            <Link
              href={href(result.page - 1)}
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
          <span className="text-muted-foreground text-sm">
            Página {result.page} de {result.totalPages}
          </span>
          {result.page < result.totalPages ? (
            <Link
              href={href(result.page + 1)}
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
