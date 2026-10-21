import { notFound } from "next/navigation"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { historyQuerySchema } from "@/modules/session-tables/session-table.schemas"
import {
  getSessionTableDetail,
  getTableCycles,
  getTableHistory,
} from "@/modules/session-tables/session-table.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"

import { BackLink } from "../../../../back-link"
import { loadSession } from "../../../../load-session"

export const metadata = { title: "Historial de la mesa — Poker Manager" }

export default async function TableHistoryPage({
  params,
  searchParams,
}: PageProps<"/dashboard/sesiones/[id]/mesas/[tableId]/historial">) {
  const { id, tableId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/mesas`
  )
  await loadSession(id, user)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) notFound()
  const table = await getSessionTableDetail(id, tableId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const raw = await searchParams
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)
  const parsed = historyQuerySchema.safeParse({
    cycle: str(raw.cycle),
    from: str(raw.from),
    to: str(raw.to),
  })
  const query = parsed.success ? parsed.data : {}
  const [allCycles, history] = await Promise.all([
    getTableCycles(id, tableId),
    getTableHistory(id, tableId, query),
  ])
  const action = `${SESSIONS_BASE}/${id}/mesas/${tableId}/historial`

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <BackLink
        href={`${SESSIONS_BASE}/${id}/mesas/${tableId}`}
        label={table.name}
      />
      <h1 className="text-xl font-semibold">Historial · {table.name}</h1>
      <form
        method="get"
        action={action}
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
        aria-label="Filtros"
      >
        <NativeSelect
          name="cycle"
          defaultValue={query.cycle ? String(query.cycle) : ""}
          aria-label="Ciclo"
        >
          <option value="">Todos los ciclos</option>
          {allCycles.map((c) => (
            <option key={c.id} value={c.cycleNumber}>
              Ciclo {c.cycleNumber}
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
        <Button type="submit" variant="secondary" className="h-11 md:h-9">
          Filtrar
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Ciclos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm" data-testid="table-cycles">
            {history.cycles.map((c) => (
              <li
                key={c.id}
                data-testid="table-cycle-row"
                className="flex flex-wrap justify-between gap-2"
              >
                <span className="font-medium">Ciclo {c.cycleNumber}</span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(c.openedAt)} ({c.openedBy.name}) →{" "}
                  {c.closedAt
                    ? `${formatDateTime(c.closedAt)} (${c.closedBy?.name ?? "—"})`
                    : "abierto"}{" "}
                  · {c.participations} participación(es)
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Movimientos de la mesa
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Aperturas, cierres, ingresos, transferencias y salidas por
            liquidación. Los importes de compras y liquidaciones están en sus
            propias pantallas.
          </p>
        </CardHeader>
        <CardContent>
          {history.events.length === 0 ? (
            <p className="text-muted-foreground text-sm">Sin movimientos.</p>
          ) : (
            <ol className="space-y-2 text-sm" data-testid="table-events">
              {history.events.map((e, i) => (
                <li
                  key={i}
                  data-testid="table-event"
                  data-kind={e.kind}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>{e.text}</span>
                  <span className="text-muted-foreground text-xs">
                    Ciclo {e.cycle} · {e.by ?? "—"} · {formatDateTime(e.at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
