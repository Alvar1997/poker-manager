"use client"

import { useMutation } from "@tanstack/react-query"
import { Check, Loader2, Palette } from "lucide-react"
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
import {
  FELT_COLORS,
  FELT_PALETTE,
  type FeltColor,
} from "@/modules/table-floor/table-floor.math"

import { errorText } from "./use-table-board"

/**
 * Color del paño (solo visual, por mesa). Paleta cerrada con contraste
 * verificado: no hay color libre. El cambio se ve al confirmar el servidor.
 */
export function TableAppearanceSettings({
  tableId,
  tableName,
  current,
  onChanged,
}: {
  tableId: string
  tableName: string
  current: FeltColor
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (feltColor: FeltColor) =>
      apiRequest(`/api/tables/${tableId}/appearance`, {
        method: "PATCH",
        body: { feltColor },
      }),
    onSuccess: (_d, color) => {
      toast.success(`Paño: ${FELT_PALETTE[color].label}`)
      onChanged()
    },
    onError: (e) => toast.error(errorText(e, "No se pudo cambiar el paño")),
  })
  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => setOpen(true)}
        data-testid="open-felt-settings"
      >
        <Palette />
        Paño
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent data-testid="felt-sheet">
          <SheetHeader>
            <SheetTitle>Color del paño · {tableName}</SheetTitle>
            <SheetDescription>
              Solo visual: no afecta caja, fichas, compras ni reportes. Cada
              mesa conserva su propio color.
            </SheetDescription>
          </SheetHeader>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            role="radiogroup"
            aria-label="Color del paño"
          >
            {FELT_COLORS.map((c) => {
              const p = FELT_PALETTE[c]
              const selected = c === current
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={save.isPending}
                  onClick={() => !selected && save.mutate(c)}
                  className={cn(
                    "relative flex h-20 flex-col items-center justify-center rounded-2xl border-4 text-sm font-semibold outline-none focus-visible:ring-4 focus-visible:ring-sky-400",
                    selected ? "border-sky-500" : "border-transparent"
                  )}
                  style={{
                    background: `radial-gradient(ellipse at 50% 40%, ${p.felt}, ${p.feltEdge})`,
                    color: p.text,
                    boxShadow: `inset 0 0 0 4px ${p.rail}`,
                  }}
                  data-testid={`felt-${c}`}
                >
                  {selected ? <Check className="size-5" aria-hidden /> : null}
                  {save.isPending && save.variables === c ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                  ) : null}
                  {p.label}
                </button>
              )
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
