import { AlertTriangle, ChevronRight, Layers } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { SETTINGS_BASE_PATH, settingsSection } from "@/config/settings-sections"
import { listChipSets } from "@/modules/chips/chip-set.service"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { ChipSetFormDialog } from "@/modules/settings/components/chip-set-form-dialog"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"

export const metadata = { title: "Juegos de fichas — Poker Manager" }

export default async function ChipSetsPage() {
  const section = settingsSection("fichas")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const sets = await listChipSets({
    includeInactive: can(user, PERMISSIONS.SETTINGS_READ),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <SettingsPageHeader
        section={section}
        canManage={canManage}
        actions={canManage ? <ChipSetFormDialog /> : null}
      />

      <p className="text-muted-foreground text-sm">
        Cada juego es <strong>físicamente distinto</strong> y tendrá su propio
        inventario. Dos fichas del mismo valor en juegos diferentes no son
        intercambiables: pasar fichas de un juego a otro requerirá una
        conversión registrada.
      </p>

      {sets.length === 0 ? (
        <EmptyState icon={Layers} title="No hay juegos de fichas" />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sets.map((set) => (
            <li key={set.id}>
              <Link
                href={`${SETTINGS_BASE_PATH}/fichas/${set.id}`}
                className="block h-full rounded-xl"
                data-testid="chip-set-card"
              >
                <Card className="hover:bg-muted/50 h-full transition-colors">
                  <CardContent className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{set.name}</p>
                        <p className="text-muted-foreground font-mono text-xs">
                          {set.code}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <ActiveBadge isActive={set.isActive} />
                        <ChevronRight
                          className="text-muted-foreground size-4"
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                    <p className="text-sm">
                      {set.activeDenominations} denominación(es) activa(s)
                      {set.tables.length > 0
                        ? ` · Mesa: ${set.tables.map((t) => t.name).join(", ")}`
                        : " · Sin mesa asignada"}
                    </p>
                    {set.needsDenominations ? (
                      <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle
                          className="size-3.5"
                          aria-hidden="true"
                        />
                        Requiere configurar denominaciones antes de abrir una
                        sesión
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
