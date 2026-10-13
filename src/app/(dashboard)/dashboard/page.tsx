import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { navigationFor } from "@/config/navigation"
import { ROLE_LABEL } from "@/config/permission-matrix"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { cn } from "@/lib/utils"

export const metadata = {
  title: "Dashboard — Poker Manager",
}

const ROLE_SUMMARY = {
  SUPERADMIN:
    "Acceso total: operación, finanzas, auditoría y administración de usuarios y seguridad.",
  PARTNER:
    "Acceso operativo y financiero completo. La administración de usuarios y la configuración crítica son exclusivas del SUPERADMIN.",
  CASHIER:
    "Operación de sesiones y caja central sin necesidad de aprobación de socios.",
} as const

export default async function DashboardPage() {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_VIEW)
  const shortcuts = navigationFor(user.role).filter(
    (item) => item.id !== "home"
  )

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Hola, {user.name}</h1>
        <p className="text-muted-foreground text-sm">
          <Badge variant="secondary" className="mr-2">
            {ROLE_LABEL[user.role]}
          </Badge>
          {ROLE_SUMMARY[user.role]}
        </p>
      </div>

      <section aria-labelledby="shortcuts-title" className="space-y-3">
        <h2 id="shortcuts-title" className="text-sm font-medium">
          Tus módulos
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((item) => {
            const Icon = item.icon
            const content = (
              <Card
                className={cn(
                  "h-full transition-colors",
                  item.available ? "hover:bg-muted/50" : "opacity-60"
                )}
              >
                <CardHeader className="flex flex-row items-center gap-3">
                  <Icon className="size-5 shrink-0" aria-hidden="true" />
                  <CardTitle className="flex-1 text-sm">{item.label}</CardTitle>
                  {!item.available ? (
                    <Badge variant="outline">Próximamente</Badge>
                  ) : null}
                </CardHeader>
                {!item.available ? (
                  <CardContent className="text-muted-foreground text-xs">
                    Se habilitará cuando se construya este módulo.
                  </CardContent>
                ) : null}
              </Card>
            )

            return (
              <li key={item.id}>
                {item.available ? (
                  <Link href={item.href} className="block h-full rounded-xl">
                    {content}
                  </Link>
                ) : (
                  <div aria-disabled="true">{content}</div>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
