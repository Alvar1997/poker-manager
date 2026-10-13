import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { UserCreateForm } from "@/modules/users/user-form"

export const metadata = {
  title: "Nuevo usuario — Poker Manager",
}

export default async function NewUserPage() {
  await requirePagePermission(PERMISSIONS.USERS_CREATE, "/dashboard/users/new")

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
            Nuevo usuario
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UserCreateForm />
        </CardContent>
      </Card>
    </div>
  )
}
