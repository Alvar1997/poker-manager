"use client"

import { Power, PowerOff } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

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
import { apiRequest } from "@/lib/api-client"

/**
 * Activar/desactivar un registro de catálogo con confirmación. Nunca
 * borra: el historial se conserva. El servidor valida permisos y reglas
 * (p. ej. no desactivar un juego asignado a una mesa activa).
 */
export function StatusToggleButton({
  url,
  method = "PATCH",
  isActive,
  entityLabel,
  deactivateWarning,
}: {
  url: string
  method?: "PATCH"
  isActive: boolean
  entityLabel: string
  deactivateWarning?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const action = isActive ? "Desactivar" : "Activar"

  async function confirm() {
    setBusy(true)
    try {
      await apiRequest(url, { method, body: { isActive: !isActive } })
      toast.success(`${entityLabel}: ${isActive ? "desactivado" : "activado"}`)
      setOpen(false)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operación fallida")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant={isActive ? "outline" : "secondary"}
        className="h-11 md:h-8"
        onClick={() => setOpen(true)}
        aria-label={`${action} ${entityLabel}`}
      >
        {isActive ? <PowerOff /> : <Power />}
        {action}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿{action} {entityLabel}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isActive
                ? (deactivateWarning ??
                  "Dejará de estar disponible para nuevas operaciones. Su historial se conserva.")
                : "Volverá a estar disponible para nuevas operaciones."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <Button
              variant={isActive ? "destructive" : "default"}
              disabled={busy}
              onClick={confirm}
            >
              Confirmar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
