import { AlertTriangle, ChevronRight } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { settingsSectionsFor } from "@/config/settings-sections"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { listChipSets } from "@/modules/chips/chip-set.service"
import { getBankAccount } from "@/modules/settings/bank-account.service"
import { getWhatsAppStatus } from "@/modules/settings/settings.service"

export const metadata = {
  title: "Configuración — Poker Manager",
}

export default async function SettingsHubPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CATALOGS_READ,
    "/dashboard/configuracion"
  )
  const sections = settingsSectionsFor(user.role)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const canReadSettings = can(user, PERMISSIONS.SETTINGS_READ)

  // Avisos de configuración pendiente (solo lo que el rol puede ver).
  const pending: Record<string, string> = {}
  const chipSets = await listChipSets({ includeInactive: false })
  const withoutDenominations = chipSets.filter((s) => s.needsDenominations)
  if (withoutDenominations.length > 0) {
    pending.fichas = `${withoutDenominations.length} juego(s) sin denominaciones`
    pending.mesas = "Requieren denominaciones antes de abrir sesión"
  }
  if (canReadSettings) {
    const [bank, whatsapp] = await Promise.all([
      getBankAccount(),
      getWhatsAppStatus(),
    ])
    if (!bank.isConfigured)
      pending.banco = "Datos bancarios pendientes de captura"
    if (whatsapp.configurationStatus === "PENDING_CONFIGURATION") {
      pending.whatsapp = "Pendiente de configuración"
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Configuración</h1>
        <p className="text-muted-foreground text-sm">
          {canManage
            ? "Administra los catálogos y parámetros del negocio."
            : "Consulta los catálogos y parámetros del negocio. Solo el SUPERADMIN puede modificarlos."}
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <li key={section.id}>
              <Link
                href={section.href}
                data-section-id={section.id}
                className="block h-full rounded-xl"
              >
                <Card className="hover:bg-muted/50 h-full transition-colors">
                  <CardContent className="flex items-start gap-3">
                    <Icon
                      className="mt-0.5 size-5 shrink-0"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-medium">{section.title}</p>
                      <p className="text-muted-foreground text-sm">
                        {section.description}
                      </p>
                      {pending[section.id] ? (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
                        >
                          <AlertTriangle aria-hidden="true" />
                          {pending[section.id]}
                        </Badge>
                      ) : null}
                    </div>
                    <ChevronRight
                      className="text-muted-foreground mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </CardContent>
                </Card>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
