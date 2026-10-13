"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // El detalle completo solo va a la consola del navegador para
    // depuración — a la UI únicamente un mensaje genérico.
    console.error("[ui_error_boundary]", error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-destructive text-sm font-medium">
        Ocurrió un error inesperado
      </p>
      <h1 className="text-xl font-semibold">Algo salió mal</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        El equipo técnico fue notificado. Puedes intentar de nuevo.
      </p>
      <Button onClick={() => reset()}>Reintentar</Button>
    </div>
  )
}
