"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useCallback } from "react"

import { ApiClientError, apiRequest } from "@/lib/api-client"
import type { TableBoard } from "@/modules/table-floor/seat.service"

export type { TableBoard }
export type Occupant = NonNullable<TableBoard["seats"][number]["occupant"]>

export const boardKey = (sessionId: string, tableId: string) =>
  ["table-board", sessionId, tableId] as const

/**
 * Datos de la mesa desde el servidor (fuente de verdad). Se refrescan al
 * volver a la pestaña y tras cada operación (`refresh`), nunca con
 * estados locales optimistas: el éxito solo se muestra con la respuesta.
 */
export function useTableBoard(
  sessionId: string,
  tableId: string,
  initialData: TableBoard
) {
  return useQuery({
    queryKey: boardKey(sessionId, tableId),
    queryFn: () =>
      apiRequest<TableBoard>(
        `/api/sessions/${sessionId}/tables/${tableId}/seats`
      ),
    initialData,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 5_000,
  })
}

/** Invalida la mesa (y las demás mesas de la sesión) y refresca la página del servidor. */
export function useRefreshFloor(sessionId: string) {
  const qc = useQueryClient()
  const router = useRouter()
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["table-board", sessionId] })
    router.refresh()
  }, [qc, router, sessionId])
}

export function errorText(e: unknown, fallback: string) {
  if (e instanceof ApiClientError) return e.fieldIssues[0]?.message ?? e.message
  return e instanceof Error ? e.message : fallback
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 2,
})
export const money = (v: string) => mxn.format(Number(v))
export const moneyShort = (v: string) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    notation: Number(v) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Number(v) >= 10_000 ? 1 : 0,
  }).format(Number(v))
