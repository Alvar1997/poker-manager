"use client"

import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function InventoryError({
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle className="text-destructive size-10" aria-hidden="true" />
      <h1 className="text-lg font-semibold">No se pudo cargar el inventario</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        Inténtalo de nuevo. Ningún movimiento se registró parcialmente.
      </p>
      <Button className="h-11 md:h-9" onClick={reset}>
        Reintentar
      </Button>
    </div>
  )
}
