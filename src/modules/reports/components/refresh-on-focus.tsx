"use client"

import { Loader2, RefreshCw } from "lucide-react"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/format"

/**
 * Actualización de reportes renderizados en el servidor (DEC-09..11): al
 * volver a la pestaña o recuperar el foco se piden de nuevo los datos
 * (`router.refresh()`), y hay un botón manual de respaldo. No hay
 * WebSocket: los cambios de otros dispositivos aparecen al refrescar.
 */
export function RefreshOnFocus({ generatedAt }: { generatedAt: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState(false)
  const last = useRef(0)

  const refresh = useCallback(() => {
    last.current = Date.now()
    setError(false)
    startTransition(() => {
      try {
        router.refresh()
      } catch {
        setError(true)
      }
    })
  }, [router])

  useEffect(() => {
    last.current = Date.now()
    const onVisible = () => {
      // Evita ráfagas: como máximo una actualización cada 5 s.
      if (
        document.visibilityState === "visible" &&
        Date.now() - last.current > 5_000
      )
        refresh()
    }
    window.addEventListener("focus", onVisible)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", onVisible)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <span data-testid="report-updated-at">
        Actualizado: {formatDateTime(generatedAt)}
      </span>
      {error ? (
        <span className="text-destructive">No se pudo actualizar.</span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className="h-9 px-2"
        onClick={refresh}
        disabled={pending}
        data-testid="refresh-report"
        aria-label="Actualizar"
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        Actualizar
      </Button>
    </div>
  )
}
