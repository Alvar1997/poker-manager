import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ROLE_LABEL } from "@/config/permission-matrix"
import { requirePageUser } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { getProfile } from "@/modules/auth/auth.service"
import { ChangePasswordForm } from "@/modules/auth/change-password-form"
import { ProfileForm } from "@/modules/auth/profile-form"
import { SignOutButton } from "@/modules/auth/sign-out-button"

export const metadata = {
  title: "Mi perfil — Poker Manager",
}

export default async function ProfilePage() {
  const user = await requirePageUser()
  const profile = await getProfile(user.id)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Mi perfil</h1>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Datos de la cuenta
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Correo</dt>
              <dd className="break-all" data-testid="profile-email">
                {profile.email}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Rol</dt>
              <dd>
                <Badge variant="secondary">{ROLE_LABEL[profile.role]}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Último acceso</dt>
              <dd>
                {profile.lastLoginAt
                  ? formatDateTime(profile.lastLoginAt)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Contraseña cambiada</dt>
              <dd>
                {profile.passwordChangedAt
                  ? formatDateTime(profile.passwordChangedAt)
                  : "—"}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-xs">
            El correo y el rol solo los puede modificar un SUPERADMIN.
          </p>
          <ProfileForm initialName={profile.name} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Cambiar contraseña
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-sm">Cerrar sesión en este dispositivo</p>
          <SignOutButton />
        </CardContent>
      </Card>
    </div>
  )
}
