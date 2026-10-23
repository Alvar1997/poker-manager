"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { History, Loader2, UserPlus } from "lucide-react"
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
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useIdempotencyKey } from "@/modules/inventory/components/use-idempotency-key"
import type { DealerView } from "@/modules/table-floor/dealer.service"

import { PokerSeatAvatar } from "./poker-table-felt"
import { errorText, type TableBoard } from "./use-table-board"

type HistoryRow = {
  id: string
  dealer: { id: string; name: string; nickname: string | null }
  cycleNumber: number
  assignedAt: string
  assignedBy: { name: string }
  releasedAt: string | null
  releaseReason: "CHANGED" | "RELEASED" | "CYCLE_CLOSED" | null
}

const RELEASE_LABEL: Record<string, string> = {
  CHANGED: "Reemplazado",
  RELEASED: "Liberado",
  CYCLE_CLOSED: "Cierre de mesa",
}

/**
 * Dealer = persona registrada (sin usuario ni asiento). Ver, asignar,
 * cambiar, liberar e historial. No hay botón «D» ni rotación (fuera de
 * alcance). Asignar un dealer no genera compras, deudas ni liquidaciones.
 */
export function DealerAssignmentSheet({
  open,
  onOpenChange,
  sessionId,
  tableId,
  tableName,
  current,
  canManage,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  tableId: string
  tableName: string
  current: TableBoard["dealer"]
  canManage: boolean
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const [view, setView] = useState<"main" | "pick" | "new" | "history">("main")
  const [assignKey, renewAssign] = useIdempotencyKey()
  const [releaseKey, renewRelease] = useIdempotencyKey()
  const dealers = useQuery({
    queryKey: ["dealers", "active"],
    queryFn: () => apiRequest<DealerView[]>("/api/dealers?status=active"),
    enabled: open && (view === "pick" || view === "main"),
  })
  const history = useQuery({
    queryKey: ["dealer-history", sessionId, tableId],
    queryFn: () =>
      apiRequest<HistoryRow[]>(
        `/api/sessions/${sessionId}/tables/${tableId}/dealer/history`
      ),
    enabled: open && view === "history",
  })
  const after = async () => {
    await qc.invalidateQueries({ queryKey: ["dealers"] })
    await qc.invalidateQueries({
      queryKey: ["dealer-history", sessionId, tableId],
    })
    onChanged()
  }
  const assign = useMutation({
    mutationFn: (dealerId: string) =>
      apiRequest(`/api/sessions/${sessionId}/tables/${tableId}/dealer/assign`, {
        method: "POST",
        body: { dealerId, idempotencyKey: assignKey },
      }),
    onSuccess: async () => {
      renewAssign()
      toast.success(current ? "Dealer cambiado" : "Dealer asignado")
      setView("main")
      await after()
    },
    onError: (e) => {
      renewAssign()
      toast.error(errorText(e, "No se pudo asignar el dealer"))
    },
  })
  const release = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/sessions/${sessionId}/tables/${tableId}/dealer/release`,
        {
          method: "POST",
          body: { idempotencyKey: releaseKey },
        }
      ),
    onSuccess: async () => {
      renewRelease()
      toast.success("Dealer liberado")
      await after()
    },
    onError: (e) => {
      renewRelease()
      toast.error(errorText(e, "No se pudo liberar"))
    },
  })
  const busy = assign.isPending || release.isPending
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (busy) return
        if (!o) setView("main")
        onOpenChange(o)
      }}
    >
      <SheetContent data-testid="dealer-sheet">
        <SheetHeader>
          <SheetTitle>Dealer · {tableName}</SheetTitle>
          <SheetDescription>
            Persona que reparte: no ocupa asiento ni tiene cuenta de acceso.
          </SheetDescription>
        </SheetHeader>

        {view === "main" ? (
          <div className="space-y-3">
            {current ? (
              <div
                className="flex items-center gap-3 rounded-xl border p-3"
                data-testid="dealer-current"
              >
                <PokerSeatAvatar
                  name={current.dealer.name}
                  className="bg-amber-300 text-zinc-950 ring-amber-500"
                />
                <div className="min-w-0">
                  <p className="font-semibold">
                    {current.dealer.name}
                    {current.dealer.nickname ? (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        · {current.dealer.nickname}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Asignado {formatDateTime(current.assignedAt)} por{" "}
                    {current.assignedBy.name}
                  </p>
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed p-3 text-sm">
                Sin dealer asignado.
              </p>
            )}
            {canManage ? (
              <>
                <Button
                  className="h-12 w-full text-base"
                  onClick={() => setView("pick")}
                  data-testid={current ? "change-dealer" : "assign-dealer"}
                >
                  {current ? "Cambiar dealer" : "Asignar dealer"}
                </Button>
                {current ? (
                  <Button
                    variant="outline"
                    className="h-11 w-full"
                    disabled={busy}
                    onClick={() => release.mutate()}
                    data-testid="release-dealer"
                  >
                    {release.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
                    Liberar asignación
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button
              variant="ghost"
              className="h-11 w-full"
              onClick={() => setView("history")}
              data-testid="dealer-history"
            >
              <History />
              Historial de dealers
            </Button>
          </div>
        ) : view === "pick" ? (
          <div className="space-y-3">
            {dealers.isLoading ? (
              <p className="text-muted-foreground text-sm">Cargando dealers…</p>
            ) : (dealers.data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Aún no hay dealers registrados.
              </p>
            ) : (
              <ul
                className="divide-y rounded-xl border"
                data-testid="dealer-options"
              >
                {dealers.data!.map((d) => {
                  const isCurrent = current?.dealer.id === d.id
                  const elsewhere = d.assignedTo && !isCurrent
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        disabled={busy || isCurrent || Boolean(elsewhere)}
                        onClick={() => assign.mutate(d.id)}
                        className={cn(
                          "focus-visible:bg-accent flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left outline-none",
                          isCurrent || elsewhere
                            ? "cursor-not-allowed opacity-70"
                            : "hover:bg-accent"
                        )}
                        data-testid="dealer-option"
                      >
                        <PokerSeatAvatar name={d.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">
                            {d.name}
                            {d.nickname ? (
                              <span className="text-muted-foreground font-normal">
                                {" "}
                                · {d.nickname}
                              </span>
                            ) : null}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {isCurrent
                              ? "Dealer actual de esta mesa"
                              : elsewhere
                                ? `En ${d.assignedTo}: libéralo allí primero`
                                : "Disponible"}
                          </span>
                        </span>
                        {assign.isPending && assign.variables === d.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => setView("new")}
              data-testid="new-dealer"
            >
              <UserPlus />
              Registrar dealer
            </Button>
            <Button
              variant="ghost"
              className="h-11 w-full"
              onClick={() => setView("main")}
            >
              Volver
            </Button>
          </div>
        ) : view === "new" ? (
          <NewDealerForm
            onCancel={() => setView("pick")}
            onCreated={async () => {
              await qc.invalidateQueries({ queryKey: ["dealers"] })
              setView("pick")
            }}
          />
        ) : (
          <div className="space-y-3">
            {history.isLoading ? (
              <p className="text-muted-foreground text-sm">
                Cargando historial…
              </p>
            ) : (history.data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Sin asignaciones en esta sesión.
              </p>
            ) : (
              <ol
                className="divide-y rounded-xl border text-sm"
                data-testid="dealer-history-list"
              >
                {history.data!.map((h) => (
                  <li key={h.id} className="space-y-0.5 p-3">
                    <p className="font-medium">
                      {h.dealer.name}{" "}
                      <span className="text-muted-foreground text-xs font-normal">
                        · ciclo {h.cycleNumber}
                      </span>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Desde {formatDateTime(h.assignedAt)} ({h.assignedBy.name})
                      {h.releasedAt
                        ? ` · hasta ${formatDateTime(h.releasedAt)} — ${RELEASE_LABEL[h.releaseReason ?? ""] ?? ""}`
                        : " · vigente"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <Button
              variant="ghost"
              className="h-11 w-full"
              onClick={() => setView("main")}
            >
              Volver
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function NewDealerForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [nickname, setNickname] = useState("")
  const create = useMutation({
    mutationFn: () =>
      apiRequest("/api/dealers", {
        method: "POST",
        body: {
          name: name.trim(),
          ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Dealer registrado")
      onCreated()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo registrar")),
  })
  const valid = name.trim().length >= 2
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !create.isPending) create.mutate()
      }}
      data-testid="new-dealer-form"
    >
      <div className="space-y-1">
        <Label htmlFor="dealer-name">Nombre</Label>
        <Input
          id="dealer-name"
          className="h-12 text-base"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="dealer-nickname">Apodo (opcional)</Label>
        <Input
          id="dealer-nickname"
          className="h-12 text-base"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          autoComplete="off"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        No se crea un usuario del sistema: el dealer no inicia sesión.
      </p>
      <Button
        type="submit"
        className="h-12 w-full"
        disabled={!valid || create.isPending}
        data-testid="save-dealer"
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : null}
        Registrar
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full"
        onClick={onCancel}
      >
        Volver
      </Button>
    </form>
  )
}
