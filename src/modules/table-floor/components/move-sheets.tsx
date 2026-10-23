"use client"

import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { apiRequest } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import { SEAT_NUMBERS } from "@/modules/table-floor/table-floor.math"

import { errorText, type Occupant } from "./use-table-board"

/** Selector de asiento libre (los ocupados no se pueden elegir: sin intercambios). */
function SeatPicker({
  free,
  value,
  onChange,
  current,
  testId,
}: {
  free: number[]
  value: number | null
  onChange: (n: number) => void
  current?: number | null
  testId: string
}) {
  return (
    <div
      className="grid grid-cols-3 gap-2"
      role="radiogroup"
      aria-label="Asiento destino"
      data-testid={testId}
    >
      {SEAT_NUMBERS.map((n) => {
        const isFree = free.includes(n)
        const isCurrent = current === n
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={!isFree}
            onClick={() => onChange(n)}
            className={cn(
              "flex h-14 flex-col items-center justify-center rounded-xl border text-sm outline-none focus-visible:ring-3 focus-visible:ring-sky-400",
              value === n
                ? "border-primary bg-primary text-primary-foreground"
                : isFree
                  ? "hover:bg-accent"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
            data-testid={`pick-seat-${n}`}
          >
            <span className="text-base font-semibold">{n}</span>
            <span className="text-[11px]">
              {isCurrent ? "Actual" : isFree ? "Libre" : "Ocupado"}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Cambio de asiento: misma participación, sin compra, liquidación, caja ni inventario. */
export function SeatChangeSheet({
  open,
  onOpenChange,
  sessionId,
  tableId,
  occupant,
  freeSeats,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  tableId: string
  occupant: Occupant
  freeSeats: number[]
  onChanged: () => void
}) {
  const [seat, setSeat] = useState<number | null>(null)
  const [key, renew] = useIdempotencyKey()
  const change = useMutation({
    mutationFn: () =>
      occupant.seatNumber === null
        ? // Activo sin asiento (registrado antes): ocupa uno libre.
          apiRequest(
            `/api/sessions/${sessionId}/tables/${tableId}/seats/${seat}/assign`,
            {
              method: "POST",
              body: {
                participationId: occupant.participationId,
                idempotencyKey: key,
              },
            }
          )
        : apiRequest(
            `/api/sessions/${sessionId}/tables/${tableId}/seats/change`,
            {
              method: "POST",
              body: {
                participationId: occupant.participationId,
                toSeat: seat,
                idempotencyKey: key,
              },
            }
          ),
    onSuccess: () => {
      renew()
      toast.success(`${occupant.player.name} pasó al asiento ${seat}`)
      setSeat(null)
      onChanged()
      onOpenChange(false)
    },
    onError: (e) => {
      renew()
      toast.error(errorText(e, "No se pudo cambiar de asiento"))
      onChanged()
    },
  })
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !change.isPending && onOpenChange(o)}
    >
      <SheetContent data-testid="seat-change-sheet">
        <SheetHeader>
          <SheetTitle>
            {occupant.seatNumber === null
              ? "Asignar asiento"
              : "Cambiar de asiento"}
          </SheetTitle>
          <SheetDescription>
            {occupant.player.name} conserva su participación, compras y deuda.
            No hay cobros, pagos ni movimientos de fichas.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4">
          <SeatPicker
            free={freeSeats}
            value={seat}
            onChange={setSeat}
            current={occupant.seatNumber}
            testId="seat-change-picker"
          />
          <Button
            className="h-12 w-full text-base"
            disabled={seat === null || change.isPending}
            onClick={() => change.mutate()}
            data-testid="confirm-seat-change"
          >
            {change.isPending ? <Loader2 className="animate-spin" /> : null}
            {seat ? `Mover al asiento ${seat}` : "Elige un asiento libre"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Transferencia a otra mesa (Módulo 07): cierra la participación de origen
 * como TRANSFERRED y crea la de destino, en el asiento elegido. Sin dinero,
 * sin inventario; las compras, la deuda y la numeración de recompras se
 * conservan (por sesión).
 */
export function TableTransferSheet({
  open,
  onOpenChange,
  sessionId,
  occupant,
  destinations,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  occupant: Occupant
  destinations: { tableId: string; name: string; freeSeats: number[] }[]
  onChanged: () => void
}) {
  const [tableId, setTableId] = useState(destinations[0]?.tableId ?? "")
  const [seat, setSeat] = useState<number | null>(null)
  const [key, renew] = useIdempotencyKey()
  const dest = destinations.find((d) => d.tableId === tableId)
  const transfer = useMutation({
    mutationFn: () =>
      apiRequest(`/api/sessions/${sessionId}/table-transfers`, {
        method: "POST",
        body: {
          sourceParticipationId: occupant.participationId,
          destinationTableId: tableId,
          destinationSeatNumber: seat,
          idempotencyKey: key,
        },
      }),
    onSuccess: () => {
      renew()
      toast.success(
        `${occupant.player.name} pasó a ${dest?.name}, asiento ${seat}`
      )
      setSeat(null)
      onChanged()
      onOpenChange(false)
    },
    onError: (e) => {
      renew()
      toast.error(errorText(e, "No se pudo transferir"))
      onChanged()
    },
  })
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !transfer.isPending && onOpenChange(o)}
    >
      <SheetContent data-testid="table-transfer-sheet">
        <SheetHeader>
          <SheetTitle>Mover de mesa</SheetTitle>
          <SheetDescription data-testid="transfer-notice">
            {occupant.player.name} conserva sus fichas, compras, deuda y la
            numeración de recompras. No genera cobros, pagos ni movimientos de
            inventario.
          </SheetDescription>
        </SheetHeader>
        {destinations.length === 0 ? (
          <p className="rounded-xl border p-3 text-sm" role="alert">
            No hay otra mesa abierta. Ábrela primero desde Mesas.
          </p>
        ) : (
          <div className="space-y-4">
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="Mesa destino"
            >
              {destinations.map((d) => (
                <button
                  key={d.tableId}
                  type="button"
                  role="radio"
                  aria-checked={tableId === d.tableId}
                  onClick={() => {
                    setTableId(d.tableId)
                    setSeat(null)
                  }}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center rounded-xl border text-sm outline-none focus-visible:ring-3 focus-visible:ring-sky-400",
                    tableId === d.tableId
                      ? "border-primary bg-primary/5 font-semibold"
                      : "hover:bg-accent"
                  )}
                  data-testid="transfer-destination"
                >
                  {d.name}
                  <span className="text-muted-foreground text-xs font-normal">
                    {d.freeSeats.length} libres
                  </span>
                </button>
              ))}
            </div>
            {dest ? (
              dest.freeSeats.length === 0 ? (
                <p className="rounded-xl border p-3 text-sm" role="alert">
                  {dest.name} no tiene asientos libres.
                </p>
              ) : (
                <SeatPicker
                  free={dest.freeSeats}
                  value={seat}
                  onChange={setSeat}
                  testId="transfer-seat-picker"
                />
              )
            ) : null}
            <Button
              className="h-12 w-full text-base"
              disabled={!tableId || seat === null || transfer.isPending}
              onClick={() => transfer.mutate()}
              data-testid="confirm-transfer"
            >
              {transfer.isPending ? <Loader2 className="animate-spin" /> : null}
              {seat
                ? `Mover a ${dest?.name}, asiento ${seat}`
                : "Elige mesa y asiento"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
