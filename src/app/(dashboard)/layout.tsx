import { redirect } from "next/navigation"

import { AppNav } from "@/components/layout/app-nav"
import { DashboardHeader } from "@/components/layout/dashboard-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentUser } from "@/config/permissions"
import { ChangePasswordForm } from "@/modules/auth/change-password-form"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // El proxy ya redirige si no hay cookie de sesión; aquí se valida la
  // sesión contra la BASE (usuario activo + sessionVersion vigente), así
  // que una cuenta desactivada o una sesión revocada vuelve a /login.
  const user = await getCurrentUser()
  if (!user) {
    redirect("/login")
  }

  if (user.mustChangePassword) {
    return (
      <div className="flex min-h-screen flex-col">
        <DashboardHeader
          userName={user.name}
          role={user.role}
          showNav={false}
        />
        <main className="mx-auto w-full max-w-md flex-1 p-4">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={1}>
                Cambia tu contraseña temporal
              </CardTitle>
              <p className="text-muted-foreground text-sm">
                Tu cuenta tiene una credencial temporal asignada por un
                administrador. Define una contraseña personal para continuar.
              </p>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm submitLabel="Guardar y continuar" />
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col">
      <DashboardHeader userName={user.name} role={user.role} />
      <div className="flex flex-1">
        <aside className="hidden w-64 shrink-0 border-r p-3 md:block">
          <div className="sticky top-16">
            <AppNav role={user.role} />
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
