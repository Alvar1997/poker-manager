"use client"

import { KeyRound, MoreVertical, Pencil, UserCheck, UserX } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { TemporaryPasswordNotice } from "@/components/shared/temporary-password-notice"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiRequest } from "@/lib/api-client"
import type { CreatedUserResult, PublicUser } from "@/modules/users/user.dto"

type PendingAction = "toggle-status" | "reset-password" | null

/**
 * Acciones administrativas sobre un usuario. Ocultar acciones para el
 * propio usuario es solo UX: el servidor también rechaza desactivarse a
 * sí mismo, cambiar el propio rol o dejar el sistema sin SUPERADMIN.
 */
export function UserActions({
  user,
  isSelf,
  variant = "menu",
}: {
  user: Pick<PublicUser, "id" | "name" | "email" | "isActive">
  isSelf: boolean
  variant?: "menu" | "buttons"
}) {
  const router = useRouter()
  const [pending, setPending] = useState<PendingAction>(null)
  const [busy, setBusy] = useState(false)
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(
    null
  )

  async function confirm() {
    setBusy(true)
    try {
      if (pending === "toggle-status") {
        await apiRequest(`/api/users/${user.id}/status`, {
          method: "PATCH",
          body: { isActive: !user.isActive },
        })
        toast.success(
          user.isActive ? "Usuario desactivado" : "Usuario activado"
        )
      }
      if (pending === "reset-password") {
        const result = await apiRequest<CreatedUserResult>(
          `/api/users/${user.id}/reset-password`,
          { method: "POST" }
        )
        setTemporaryPassword(result.temporaryPassword)
      }
      setPending(null)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operación fallida")
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = user.isActive ? "Desactivar" : "Activar"

  return (
    <>
      {variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={`Acciones para ${user.name}`}
              />
            }
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              className="min-h-10"
              render={<Link href={`/dashboard/users/${user.id}`} />}
            >
              <Pencil />
              Editar
            </DropdownMenuItem>
            {!isSelf ? (
              <>
                <DropdownMenuItem
                  className="min-h-10"
                  onClick={() => setPending("reset-password")}
                >
                  <KeyRound />
                  Restablecer contraseña
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-10"
                  variant={user.isActive ? "destructive" : "default"}
                  onClick={() => setPending("toggle-status")}
                >
                  {user.isActive ? <UserX /> : <UserCheck />}
                  {statusLabel}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : !isSelf ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => setPending("reset-password")}
          >
            <KeyRound />
            Restablecer contraseña
          </Button>
          <Button
            variant={user.isActive ? "destructive" : "outline"}
            className="h-11 md:h-9"
            onClick={() => setPending("toggle-status")}
          >
            {user.isActive ? <UserX /> : <UserCheck />}
            {statusLabel} usuario
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No puedes desactivar tu propia cuenta ni restablecer tu contraseña
          desde aquí. Usa tu perfil para cambiarla.
        </p>
      )}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && !busy && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === "reset-password"
                ? "¿Restablecer contraseña?"
                : `¿${statusLabel} a ${user.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending === "reset-password"
                ? "Se generará una credencial temporal, se cerrarán sus sesiones abiertas y deberá cambiarla en su próximo acceso."
                : user.isActive
                  ? "No podrá iniciar sesión y sus sesiones abiertas se cerrarán. Su historial se conserva."
                  : "Podrá volver a iniciar sesión con su contraseña actual."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <Button
              variant={
                pending === "toggle-status" && user.isActive
                  ? "destructive"
                  : "default"
              }
              disabled={busy}
              onClick={confirm}
            >
              Confirmar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={temporaryPassword !== null}
        onOpenChange={(open) => !open && setTemporaryPassword(null)}
      >
        <DialogContent>
          <DialogTitle>Contraseña restablecida</DialogTitle>
          <DialogDescription className="sr-only">
            Credencial temporal para {user.email}
          </DialogDescription>
          {temporaryPassword ? (
            <TemporaryPasswordNotice
              email={user.email}
              password={temporaryPassword}
            />
          ) : null}
          <Button onClick={() => setTemporaryPassword(null)}>Listo</Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
