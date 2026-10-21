import { ArrowLeft, ChevronLeft, ChevronRight, History } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { NativeSelect } from "@/components/shared/native-select"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  formatChips,
  formatNominal,
} from "@/modules/inventory/components/format"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import {
  MOVEMENT_TYPE_LABEL,
  MOVEMENT_TYPES,
  movementsQuerySchema,
} from "@/modules/inventory/inventory.schemas"
import {
  listMovements,
  movementFilterOptions,
} from "@/modules/inventory/inventory.service"

export const metadata = { title: "Movimientos de fichas — Poker Manager" }

const LOCATION_LABEL: Record<string, string> = {
  CUSTODY: "inventario",
  CIRCULATION: "circulación",
  RETIRED: "baja",
}

export default async function MovementsPage({
  searchParams,
}: PageProps<"/dashboard/inventario/fichas/movimientos">) {
  await requirePagePermission(
    PERMISSIONS.CHIPS_READ,
    `${INVENTORY_BASE}/movimientos`
  )
  const raw = await searchParams
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const parsed = movementsQuerySchema.safeParse({
    tableId: str(raw.tableId),
    type: str(raw.type),
    denominationId: str(raw.denominationId),
    userId: str(raw.userId),
    from: str(raw.from),
    to: str(raw.to),
    page: str(raw.page),
    pageSize: 20,
  })
  const query = parsed.success
    ? parsed.data
    : movementsQuerySchema.parse({ pageSize: 20 })

  const [result, { chipSets, tables, users }] = await Promise.all([
    listMovements(query),
    movementFilterOptions(),
  ])

  const href = (page: number) => {
    const p = new URLSearchParams()
    for (const k of [
      "tableId",
      "type",
      "denominationId",
      "userId",
      "from",
      "to",
    ] as const) {
      if (query[k]) p.set(k, String(query[k]))
    }
    p.set("page", String(page))
    return `${INVENTORY_BASE}/movimientos?${p}`
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link
        href={INVENTORY_BASE}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Inventario de fichas
      </Link>
      <h1 className="text-xl font-semibold">Movimientos de fichas</h1>
      <p className="text-muted-foreground text-sm">
        Inventario común a todas las mesas: el filtro de mesa solo muestra los
        movimientos originados en ella.
      </p>

      <form
        method="get"
        action={`${INVENTORY_BASE}/movimientos`}
        className="grid grid-cols-2 gap-2 md:grid-cols-3"
        aria-label="Filtros"
      >
        <NativeSelect
          name="tableId"
          defaultValue={query.tableId ?? ""}
          aria-label="Mesa"
        >
          <option value="">Todas las mesas</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="type"
          defaultValue={query.type ?? ""}
          aria-label="Tipo"
        >
          <option value="">Todos los tipos</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {MOVEMENT_TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="denominationId"
          defaultValue={query.denominationId ?? ""}
          aria-label="Denominación"
        >
          <option value="">Todas las denominaciones</option>
          {chipSets.flatMap((s) =>
            s.denominations.map((d) => (
              <option key={d.id} value={d.id}>
                {s.name} · {formatNominal(d.value)}
                {d.color ? ` ${d.color}` : ""}
              </option>
            ))
          )}
        </NativeSelect>
        <NativeSelect
          name="userId"
          defaultValue={query.userId ?? ""}
          aria-label="Usuario"
        >
          <option value="">Todos los usuarios</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </NativeSelect>
        <Input
          type="date"
          name="from"
          defaultValue={query.from ?? ""}
          aria-label="Desde"
          className="h-11 md:h-9"
        />
        <Input
          type="date"
          name="to"
          defaultValue={query.to ?? ""}
          aria-label="Hasta"
          className="h-11 md:h-9"
        />
        <Button
          type="submit"
          variant="secondary"
          className="col-span-2 h-11 md:col-span-3 md:h-9"
        >
          Filtrar
        </Button>
      </form>

      {result.items.length === 0 ? (
        <EmptyState
          icon={History}
          title="Sin movimientos"
          description="No hay movimientos con estos filtros."
        />
      ) : (
        <ul className="space-y-2" data-testid="movement-list">
          {result.items.map((m) => (
            <li key={m.id}>
              <Card data-testid="movement-row">
                <CardContent className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="secondary">
                      {
                        MOVEMENT_TYPE_LABEL[
                          m.movementType as keyof typeof MOVEMENT_TYPE_LABEL
                        ]
                      }
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(m.createdAt)}
                    </span>
                  </div>
                  <p className="font-medium">
                    {m.chipSet.name} · {formatNominal(m.unitValue)}
                    {m.denomination.color
                      ? ` ${m.denomination.color}`
                      : ""} ·{" "}
                    <span className="tabular-nums">
                      {m.toLocation === "CUSTODY"
                        ? "+"
                        : m.fromLocation === "CUSTODY"
                          ? "−"
                          : ""}
                      {formatChips(m.quantity)}
                    </span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {m.fromLocation ? LOCATION_LABEL[m.fromLocation] : "fuera"}{" "}
                    → {m.toLocation ? LOCATION_LABEL[m.toLocation] : "fuera"} ·
                    custodia {formatChips(m.custodyBefore)} →{" "}
                    {formatChips(m.custodyAfter)} · {m.containerCode}
                  </p>
                  {m.table || m.player ? (
                    <p className="text-xs" data-testid="movement-origin">
                      {m.table ? `Mesa: ${m.table.name}` : ""}
                      {m.table && m.player ? " · " : ""}
                      {m.player ? `Jugador: ${m.player.name}` : ""}
                    </p>
                  ) : null}
                  {m.reason ? (
                    <p className="text-xs">Motivo: {m.reason}</p>
                  ) : null}
                  <p className="text-muted-foreground text-xs">
                    {m.createdBy?.name ?? "Sistema"}
                    {m.stockCountId ? (
                      <>
                        {" "}
                        ·{" "}
                        <Link
                          className="underline"
                          href={`${INVENTORY_BASE}/arqueos/${m.stockCountId}`}
                        >
                          ver arqueo
                        </Link>
                      </>
                    ) : m.referenceType ? (
                      ` · ${m.referenceType} ${m.referenceId}`
                    ) : (
                      ""
                    )}
                  </p>
                </CardContent>
              </Card>
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
