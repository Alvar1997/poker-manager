"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { ArrowRightLeft, Loader2, Search, UserPlus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/shared/native-select"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiRequest } from "@/lib/api-client"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"

const fail = (fallback: string) => (e: unknown) =>
  toast.error(e instanceof Error ? e.message : fallback)

/** Abrir / reabrir (ciclo nuevo) o cerrar una mesa. El cierre pide confirmación. */
export function TableStatusButton({
  sessionId,
  tableId,
  tableName,
  status,
}: {
  sessionId: string
  tableId: string
  tableName: string
  status: "PENDING" | "OPEN" | "CLOSED"
}) {
  const router = useRouter()
  const [key, renew] = useIdempotencyKey()
  const [confirm, setConfirm] = useState(false)
  const action = status === "OPEN" ? "close" : "open"
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/sessions/${sessionId}/tables/${tableId}/${action}`, {
        method: "POST",
        body: { idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      setConfirm(false)
      toast.success(
        action === "close" ? `${tableName} cerrada` : `${tableName} abierta`
      )
      router.refresh()
    },
    onError: fail("No se pudo completar la acción"),
  })
  const label =
    status === "OPEN"
      ? "Cerrar mesa"
      : status === "CLOSED"
        ? "Reabrir mesa"
        : "Abrir mesa"
  return (
    <>
      <Button
        variant={status === "OPEN" ? "outline" : "default"}
        className="h-11 w-full md:h-9 md:w-auto"
        disabled={mutation.isPending}
        onClick={() =>
          action === "close" ? setConfirm(true) : mutation.mutate()
        }
        data-testid={`table-${action}`}
      >
        {mutation.isPending && action === "open" ? (
          <Loader2 className="animate-spin" />
        ) : null}
        {label}
      </Button>
      <AlertDialog
        open={confirm}
        onOpenChange={(o) => !o && !mutation.isPending && setConfirm(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cerrar {tableName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Termina el ciclo actual. No mueve dinero ni fichas y la sesión
              sigue abierta. Podrás reabrirla después.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              Volver
            </AlertDialogCancel>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              data-testid="confirm-close-table"
            >
              {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Cerrar mesa
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

type PlayerHit = {
  id: string
  name: string
  nickname: string | null
  phone: string | null
}

/** Agregar jugador desde el directorio del Módulo 03 (no crea compras ni entrega fichas). */
export function AddPlayerPanel({
  sessionId,
  tableId,
}: {
  sessionId: string
  tableId: string
}) {
  const router = useRouter()
  const [q, setQ] = useState("")
  const [key, renew] = useIdempotencyKey()
  const term = q.trim()
  const search = useQuery({
    queryKey: ["players-search", term],
    queryFn: () =>
      apiRequest<{ items: PlayerHit[] }>(
        `/api/players?status=active&pageSize=10&q=${encodeURIComponent(term)}`
      ),
    enabled: term.length >= 2,
  })
  const add = useMutation({
    mutationFn: (playerId: string) =>
      apiRequest(`/api/sessions/${sessionId}/tables/${tableId}/players`, {
        method: "POST",
        body: { playerId, idempotencyKey: key },
      }),
    onSuccess: () => {
      renew()
      setQ("")
      toast.success("Jugador registrado en la mesa")
      router.refresh()
    },
    onError: (e) => {
      renew()
      fail("No se pudo registrar al jugador")(e)
    },
  })
  return (
    <div className="space-y-2">
      <Label htmlFor="player-search">Agregar jugador</Label>
      <div className="relative">
        <Search
          className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id="player-search"
          placeholder="Nombre, apodo o teléfono"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-11 pl-8 md:h-9"
          autoComplete="off"
        />
      </div>
      {term.length >= 2 ? (
        search.isLoading ? (
          <p className="text-muted-foreground text-sm">Buscando…</p>
        ) : (search.data?.items.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">
            Sin jugadores activos con esa búsqueda.
          </p>
        ) : (
          <ul
            className="divide-y rounded-lg border"
            data-testid="player-search-results"
          >
            {search.data!.items.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 p-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {p.name}
                  {p.nickname ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {p.nickname}
                    </span>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  className="h-10 md:h-8"
                  disabled={add.isPending}
                  onClick={() => add.mutate(p.id)}
                  data-testid="add-player"
                >
                  {add.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <UserPlus />
                  )}
                  Agregar
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}

/** Cambiar de mesa: sin conteo de fichas, sin cobros ni pagos, sin inventario. */
export function TransferButton({
  sessionId,
  participationId,
  playerName,
  destinations,
}: {
  sessionId: string
  participationId: string
  playerName: string
  destinations: { tableId: string; name: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [destination, setDestination] = useState(destinations[0]?.tableId ?? "")
  const [key, renew] = useIdempotencyKey()
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/sessions/${sessionId}/table-transfers`, {
        method: "POST",
        body: {
          sourceParticipationId: participationId,
          destinationTableId: destination,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      setOpen(false)
      toast.success("La transferencia se realizó correctamente.")
      router.refresh()
    },
    onError: fail("No se pudo transferir"),
  })
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-10 md:h-8"
        disabled={destinations.length === 0}
        onClick={() => setOpen(true)}
        data-testid="transfer-player"
      >
        <ArrowRightLeft />
        Cambiar de mesa
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => !o && !mutation.isPending && setOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cambiar de mesa a {playerName}</AlertDialogTitle>
            <AlertDialogDescription data-testid="transfer-notice">
              El jugador conservará sus fichas. Esta operación no genera cobros,
              pagos ni movimientos de inventario.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 text-sm">
            <Label htmlFor="transfer-destination">Mesa destino</Label>
            <NativeSelect
              id="transfer-destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              {destinations.map((d) => (
                <option key={d.tableId} value={d.tableId}>
                  {d.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <Button
              disabled={mutation.isPending || !destination}
              onClick={() => mutation.mutate()}
              data-testid="confirm-transfer"
            >
              {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Confirmar cambio
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
