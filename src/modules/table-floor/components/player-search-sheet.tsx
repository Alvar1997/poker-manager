"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2, Search, UserPlus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

import { errorText } from "./use-table-board"

type Candidate = {
  id: string
  name: string
  nickname: string | null
  phone: string | null
  selectable: boolean
  blockedReason: string | null
}

/**
 * Asiento libre: buscar (nombre, apodo o teléfono; sin acentos), elegir y
 * confirmar. Sentar NO crea compra, crédito ni entrega fichas: el jugador
 * queda «pendiente de compra». También permite dar de alta a un jugador
 * nuevo sin salir de la mesa (Módulo 03).
 */
export function PlayerSearchSheet({
  open,
  onOpenChange,
  sessionId,
  tableId,
  tableName,
  seatNumber,
  canCreatePlayers,
  onSeated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  tableId: string
  tableName: string
  seatNumber: number
  canCreatePlayers: boolean
  onSeated: () => void
}) {
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [creating, setCreating] = useState(false)
  const [key, renew] = useIdempotencyKey()
  const term = q.trim()
  const search = useQuery({
    queryKey: ["seat-candidates", sessionId, tableId, term],
    queryFn: () =>
      apiRequest<Candidate[]>(
        `/api/sessions/${sessionId}/tables/${tableId}/seat-candidates?q=${encodeURIComponent(term)}`
      ),
    enabled: open && term.length >= 2 && !creating,
  })
  const seat = useMutation({
    mutationFn: (playerId: string) =>
      apiRequest(
        `/api/sessions/${sessionId}/tables/${tableId}/seats/${seatNumber}/assign`,
        { method: "POST", body: { playerId, idempotencyKey: key } }
      ),
    onSuccess: () => {
      renew()
      toast.success(`Jugador sentado en el asiento ${seatNumber}`)
      setQ("")
      setSelected(null)
      onSeated()
    },
    onError: (e) => {
      renew()
      toast.error(errorText(e, "No se pudo sentar al jugador"))
    },
  })
  const close = (o: boolean) => {
    if (seat.isPending) return
    if (!o) {
      setSelected(null)
      setCreating(false)
    }
    onOpenChange(o)
  }
  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent data-testid="player-search-sheet">
        <SheetHeader>
          <SheetTitle>
            Asiento {seatNumber} · {tableName}
          </SheetTitle>
          <SheetDescription>
            Sentar no genera compra, crédito ni entrega de fichas: queda
            pendiente de compra.
          </SheetDescription>
        </SheetHeader>
        {creating ? (
          <PlayerRegistrationForm
            onCancel={() => setCreating(false)}
            onCreated={(c) => {
              setCreating(false)
              setSelected(c)
            }}
          />
        ) : selected ? (
          <div className="space-y-3">
            <div className="rounded-xl border p-3">
              <p
                className="text-base font-semibold"
                data-testid="selected-player"
              >
                {selected.name}
                {selected.nickname ? (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    · {selected.nickname}
                  </span>
                ) : null}
              </p>
              {selected.phone ? (
                <p className="text-muted-foreground text-xs">
                  {selected.phone}
                </p>
              ) : null}
            </div>
            <Button
              className="h-12 w-full text-base"
              disabled={seat.isPending}
              onClick={() => seat.mutate(selected.id)}
              data-testid="confirm-seat"
            >
              {seat.isPending ? <Loader2 className="animate-spin" /> : null}
              Sentar en el asiento {seatNumber}
            </Button>
            <Button
              variant="outline"
              className="h-11 w-full"
              disabled={seat.isPending}
              onClick={() => setSelected(null)}
            >
              Elegir otro jugador
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="seat-player-search">Buscar jugador</Label>
            <div className="relative">
              <Search
                className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                id="seat-player-search"
                autoFocus
                placeholder="Nombre, apodo o teléfono"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-12 pl-9 text-base"
                autoComplete="off"
                data-testid="seat-player-search"
              />
            </div>
            {term.length >= 2 ? (
              search.isLoading ? (
                <p className="text-muted-foreground text-sm">Buscando…</p>
              ) : search.isError ? (
                <p className="text-destructive text-sm" role="alert">
                  {errorText(search.error, "No se pudo buscar")}
                </p>
              ) : (search.data?.length ?? 0) === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Sin coincidencias.
                </p>
              ) : (
                <ul
                  className="divide-y rounded-xl border"
                  data-testid="seat-candidates"
                >
                  {search.data!.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={!c.selectable}
                        onClick={() => setSelected(c)}
                        className={cn(
                          "focus-visible:bg-accent flex min-h-14 w-full flex-col items-start justify-center px-3 py-2 text-left outline-none",
                          c.selectable
                            ? "hover:bg-accent"
                            : "cursor-not-allowed opacity-70"
                        )}
                        data-testid="seat-candidate"
                      >
                        <span className="font-medium">
                          {c.name}
                          {c.nickname ? (
                            <span className="text-muted-foreground font-normal">
                              {" "}
                              · {c.nickname}
                            </span>
                          ) : null}
                        </span>
                        {c.blockedReason ? (
                          <span className="text-xs text-amber-700 dark:text-amber-400">
                            {c.blockedReason}
                          </span>
                        ) : c.phone ? (
                          <span className="text-muted-foreground text-xs">
                            {c.phone}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <p className="text-muted-foreground text-xs">
                Escribe al menos 2 letras. No importan los acentos.
              </p>
            )}
            {canCreatePlayers ? (
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={() => setCreating(true)}
                data-testid="create-player-from-seat"
              >
                <UserPlus />
                Registrar jugador nuevo
              </Button>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Alta rápida de jugador (Módulo 03): nombre, apodo y teléfono. El consentimiento de WhatsApp se gestiona en Jugadores. */
export function PlayerRegistrationForm({
  onCreated,
  onCancel,
}: {
  onCreated: (c: Candidate) => void
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [nickname, setNickname] = useState("")
  const [phone, setPhone] = useState("")
  const create = useMutation({
    mutationFn: () =>
      apiRequest<{
        id: string
        name: string
        nickname: string | null
        phoneDisplay?: string
      }>("/api/players", {
        method: "POST",
        body: {
          name: name.trim(),
          ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
          phone: phone.trim(),
        },
      }),
    onSuccess: (p) => {
      toast.success("Jugador registrado")
      onCreated({
        id: p.id,
        name: p.name,
        nickname: p.nickname,
        phone: p.phoneDisplay ?? null,
        selectable: true,
        blockedReason: null,
      })
    },
    onError: (e) =>
      toast.error(errorText(e, "No se pudo registrar al jugador")),
  })
  const valid = name.trim().length >= 2 && phone.replace(/\D/g, "").length >= 10
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !create.isPending) create.mutate()
      }}
      data-testid="player-registration-form"
    >
      <div className="space-y-1">
        <Label htmlFor="new-player-name">Nombre</Label>
        <Input
          id="new-player-name"
          className="h-12 text-base"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="new-player-nickname">Apodo (opcional)</Label>
        <Input
          id="new-player-nickname"
          className="h-12 text-base"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="new-player-phone">Teléfono</Label>
        <Input
          id="new-player-phone"
          className="h-12 text-base"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          10 dígitos (México) o con +código de país.
        </p>
      </div>
      <Button
        type="submit"
        className="h-12 w-full text-base"
        disabled={!valid || create.isPending}
        data-testid="save-new-player"
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar y seleccionar
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full"
        onClick={onCancel}
        disabled={create.isPending}
      >
        Volver a buscar
      </Button>
    </form>
  )
}
