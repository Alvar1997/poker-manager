import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { UserActions } from "@/modules/users/user-actions"
import { UserEditForm } from "@/modules/users/user-form"
import { UserStatusBadge } from "@/modules/users/user-status-badge"
import { userIdSchema } from "@/modules/users/user.schemas"
import { getUserById } from "@/modules/users/user.service"

export const metadata = {
  title: "Editar usuario — Poker Manager",
}

export default async function EditUserPage({
  params,
}: PageProps<"/dashboard/users/[id]">) {
  const actor = await requirePagePermission(
    PERMISSIONS.USERS_UPDATE,
    "/dashboard/users/[id]"
  )
  const { id } = await params
  if (!userIdSchema.safeParse(id).success) notFound()

  const user = await getUserById(id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound()
    throw error
  })
  const isSelf = user.id === actor.id

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link
        href="/dashboard/users"
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Usuarios
      </Link>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Editar usuario
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UserEditForm user={user} isSelf={isSelf} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Estado de la cuenta <UserStatusBadge isActive={user.isActive} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Creado</dt>
              <dd>
                {formatDateTime(user.createdAt)}
                {user.createdBy ? ` · por ${user.createdBy.name}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Último acceso</dt>
              <dd>
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Nunca"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Última modificación</dt>
              <dd>
                {formatDateTime(user.updatedAt)}
                {user.updatedBy ? ` · por ${user.updatedBy.name}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Contraseña</dt>
              <dd>
                {user.mustChangePassword
                  ? "Credencial temporal pendiente de cambio"
                  : user.passwordChangedAt
                    ? `Cambiada ${formatDateTime(user.passwordChangedAt)}`
                    : "Definida"}
              </dd>
            </div>
          </dl>
          <UserActions user={user} isSelf={isSelf} variant="buttons" />
        </CardContent>
      </Card>
    </div>
  )
}
