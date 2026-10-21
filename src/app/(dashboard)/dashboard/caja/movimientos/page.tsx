import { ChevronLeft, ChevronRight, History } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { NativeSelect } from "@/components/shared/native-select"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { cn } from "@/lib/utils"
import {
  movementsQuerySchema,
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPES,
} from "@/modules/cash/cash.schemas"
import { listMovements } from "@/modules/cash/cash.service"
import {
  CASH_BASE,
  MOVEMENT_STATUS_LABEL,
} from "@/modules/cash/components/format"

import { BackToCash } from "../back-link"
import { MovementCard } from "../movement-card"

export const metadata = { title: "Movimientos de caja — Poker Manager" }

const FILTERS = [
  "type",
  "status",
  "method",
  "folio",
  "reference",
  "from",
  "to",
] as const

export default async function CashMovementsPage({
  searchParams,
}: PageProps<"/dashboard/caja/movimientos">) {
  await requirePagePermission(PERMISSIONS.CASH_READ, `${CASH_BASE}/movimientos`)
  const raw = await searchParams
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const parsed = movementsQuerySchema.safeParse({
    ...Object.fromEntries(FILTERS.map((k) => [k, str(raw[k])])),
    page: str(raw.page),
    pageSize: 20,
  })
  const query = parsed.success
    ? parsed.data
    : movementsQuerySchema.parse({ pageSize: 20 })
  const result = await listMovements(query)

  const href = (page: number) => {
    const p = new URLSearchParams()
    for (const k of FILTERS) if (query[k]) p.set(k, String(query[k]))
    p.set("page", String(page))
    return `${CASH_BASE}/movimientos?${p}`
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <BackToCash />
      <h1 className="text-xl font-semibold">Movimientos de caja</h1>

      <form
        method="get"
        action={`${CASH_BASE}/movimientos`}
        className="grid grid-cols-2 gap-2 md:grid-cols-3"
        aria-label="Filtros"
      >
        <NativeSelect
          name="type"
          defaultValue={query.type ?? ""}
          aria-label="Tipo"
        >
          <option value="">Todos los tipos</option>
          {TRANSACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRANSACTION_TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="status"
          defaultValue={query.status ?? ""}
          aria-label="Estado"
        >
          <option value="">Todos los estados</option>
          {Object.entries(MOVEMENT_STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="method"
          defaultValue={query.method ?? ""}
          aria-label="Método"
        >
          <option value="">Efectivo y banco</option>
          <option value="CASH">Efectivo</option>
          <option value="BANK">Banco</option>
        </NativeSelect>
        <Input
          name="folio"
          placeholder="Folio"
          defaultValue={query.folio ?? ""}
          aria-label="Folio"
          className="h-11 md:h-9"
        />
        <Input
          name="reference"
          placeholder="Referencia"
          defaultValue={query.reference ?? ""}
          aria-label="Referencia"
          className="h-11 md:h-9"
        />
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
          className="col-span-2 h-11 md:col-span-2 md:h-9"
        >
          Filtrar
        </Button>
      </form>

      {result.items.length === 0 ? (
        <EmptyState
          icon={History}
          title="Sin movimientos"
          description="No hay movimientos de dinero con estos filtros."
        />
      ) : (
        <ul className="space-y-2" data-testid="cash-movement-list">
          {result.items.map((m) => (
            <li key={m.id}>
              <MovementCard m={m} />
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
