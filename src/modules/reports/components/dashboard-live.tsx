"use client"

import { useQuery } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { apiRequest } from "@/lib/api-client"
import { formatDateTime } from "@/lib/format"
import { formatMXN } from "@/modules/cash/components/format"
import type {
  DashboardReport,
  Kpi,
} from "@/modules/reports/dashboard-report.service"

/**
 * Dashboard en vivo (TanStack Query). Se actualiza: al montar (volver a la
 * pantalla), al recuperar el foco, tras cualquier mutación de la app
 * (`QueryProvider` invalida `["reports"]`) y con el botón manual. Ante un
 * error conserva los últimos datos válidos. Sin WebSocket (DEC-11).
 */

export const DASHBOARD_QUERY_KEY = ["reports", "dashboard"] as const

const STATUS: Record<string, string> = {
  DRAFT: "Borrador",
  PREPARATION: "Preparación",
  OPEN: "Abierta",
  CLOSING: "En cierre",
}

function KpiCard({ k }: { k: Kpi }) {
  const value =
    k.unit === "MXN" || k.unit === "MXN nominal"
      ? formatMXN(k.value)
      : k.id === "session-status"
        ? (STATUS[k.value] ?? k.value)
        : k.value
  return (
    <div className="rounded-lg border p-3" data-testid={`kpi-${k.id}`}>
      <p className="text-muted-foreground text-xs">{k.label}</p>
      <p
        className="text-lg font-semibold tabular-nums"
        data-testid={`kpi-${k.id}-value`}
      >
        {value}
      </p>
      <p className="text-muted-foreground text-[11px]">
        {k.unit === "MXN nominal" ? "Valor nominal · " : ""}
        {k.period === "SESSION" ? "Sesión vigente" : "Global, a la fecha"}
      </p>
      {k.hint ? (
        <p className="text-muted-foreground mt-1 text-xs">{k.hint}</p>
      ) : null}
    </div>
  )
}

export function DashboardLive({ initial }: { initial: DashboardReport }) {
  const q = useQuery({
    queryKey: DASHBOARD_QUERY_KEY,
    queryFn: () => apiRequest<DashboardReport>("/api/reports/dashboard"),
    initialData: initial,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  })
  const d = q.data
  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span data-testid="dashboard-updated-at">
          Actualizado: {formatDateTime(d.generatedAt)}
        </span>
        {q.isError ? (
          <span className="text-destructive" data-testid="dashboard-error">
            No se pudo actualizar; se muestran los últimos datos válidos.
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-9 px-2"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          data-testid="dashboard-refresh"
        >
          {q.isFetching ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          Actualizar
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sesión vigente</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="grid grid-cols-2 gap-2 md:grid-cols-3"
            data-testid="session-kpis"
          >
            {d.sessionKpis.map((k) => (
              <KpiCard key={k.id} k={k} />
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Global, a la fecha</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="grid grid-cols-2 gap-2 md:grid-cols-3"
            data-testid="global-kpis"
          >
            {d.globalKpis.map((k) => (
              <KpiCard key={k.id} k={k} />
            ))}
          </div>
          {!d.ledgerConsistent ? (
            <p className="text-destructive mt-2 text-xs">
              La proyección del inventario no coincide con su libro de
              movimientos: revisa el inventario.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
