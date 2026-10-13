import { Plus, Users } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ROLE_LABEL } from "@/config/permission-matrix"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { UserActions } from "@/modules/users/user-actions"
import { UserFilters } from "@/modules/users/user-filters"
import { UserStatusBadge } from "@/modules/users/user-status-badge"
import { listUsersQuerySchema } from "@/modules/users/user.schemas"
import { listUsers } from "@/modules/users/user.service"

export const metadata = {
  title: "Usuarios — Poker Manager",
}

export default async function UsersPage({
  searchParams,
}: PageProps<"/dashboard/users">) {
  const actor = await requirePagePermission(
    PERMISSIONS.USERS_READ,
    "/dashboard/users"
  )

  const raw = await searchParams
  const parsed = listUsersQuerySchema.safeParse({
    q: typeof raw.q === "string" && raw.q ? raw.q : undefined,
    role: typeof raw.role === "string" && raw.role ? raw.role : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
  })
  const query = parsed.success ? parsed.data : listUsersQuerySchema.parse({})
  const users = await listUsers(query)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Usuarios</h1>
          <p className="text-muted-foreground text-sm">
            {users.length} {users.length === 1 ? "usuario" : "usuarios"}
          </p>
        </div>
        <Link
          href="/dashboard/users/new"
          className={cn(buttonVariants(), "h-11 md:h-9")}
        >
          <Plus />
          Nuevo usuario
        </Link>
      </div>

      <UserFilters query={query} />

      {users.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin resultados"
          description="Ningún usuario coincide con la búsqueda o filtros."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {users.map((user) => (
            <li key={user.id}>
              <Card data-testid="user-card" className="h-full">
                <CardContent className="space-y-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {user.name}
                        {user.id === actor.id ? (
                          <span className="text-muted-foreground font-normal">
                            {" "}
                            (tú)
                          </span>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground truncate text-sm">
                        {user.email}
                      </p>
                    </div>
                    <UserActions user={user} isSelf={user.id === actor.id} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{ROLE_LABEL[user.role]}</Badge>
                    <UserStatusBadge isActive={user.isActive} />
                    {user.mustChangePassword ? (
                      <Badge variant="outline">Credencial temporal</Badge>
                    ) : null}
                  </div>
                  <dl className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt>Creado</dt>
                      <dd className="text-foreground">
                        {formatDateTime(user.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>Último acceso</dt>
                      <dd className="text-foreground">
                        {user.lastLoginAt
                          ? formatDateTime(user.lastLoginAt)
                          : "Nunca"}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
