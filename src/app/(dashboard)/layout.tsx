import { redirect } from "next/navigation"

import { DashboardHeader } from "@/components/layout/dashboard-header"
import { getCurrentUser } from "@/config/permissions"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // El middleware ya redirige si no hay sesión; esta verificación es una
  // segunda capa de defensa (p. ej. si el middleware no corriera por
  // alguna razón) y además nos da los datos del usuario para el header.
  const user = await getCurrentUser()
  if (!user || !user.isActive) {
    redirect("/login")
  }

  return (
    <div className="flex min-h-screen flex-col">
      <DashboardHeader
        userName={user.name ?? user.email ?? ""}
        role={user.role}
      />
      <main className="flex-1 p-4">{children}</main>
    </div>
  )
}
