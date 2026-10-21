import { AlertTriangle, CheckCircle2, Table2 } from "lucide-react"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { listChipSets } from "@/modules/chips/chip-set.service"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { StatusToggleButton } from "@/modules/settings/components/status-toggle-button"
import { TableFormDialog } from "@/modules/settings/components/table-form-dialog"
import { listTables } from "@/modules/tables/table.service"

export const metadata = { title: "Mesas — Poker Manager" }

export default async function TablesPage() {
  const section = settingsSection("mesas")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)

  const [tables, chipSets] = await Promise.all([
    listTables({ includeInactive }),
    canManage ? listChipSets({ includeInactive: false }) : Promise.resolve([]),
  ])
  const chipSetOptions = chipSets.map((s) => ({
    id: s.id,
    name: s.name,
    code: s.code,
  }))

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <SettingsPageHeader
        section={section}
        canManage={canManage}
        actions={
          canManage ? <TableFormDialog chipSets={chipSetOptions} /> : null
        }
      />

      {tables.length === 0 ? (
        <EmptyState icon={Table2} title="No hay mesas" />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {tables.map((table) => (
            <li key={table.id}>
              <Card data-testid="table-card" className="h-full">
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{table.name}</p>
                      <p className="text-muted-foreground font-mono text-xs">
                        {table.code}
                      </p>
                    </div>
                    <ActiveBadge
                      isActive={table.isActive}
                      activeLabel="Activa"
                      inactiveLabel="Inactiva"
                    />
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground text-xs">Ciegas</dt>
                      <dd className="font-medium" data-testid="table-blinds">
                        ${table.smallBlind} / ${table.bigBlind}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs">
                        Inventario de fichas
                      </dt>
                      <dd className="font-medium" data-testid="table-chip-set">
                        {table.chipSet.name}
                      </dd>
                    </div>
                  </dl>
                  {table.readyForSession ? (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5" aria-hidden="true" />
                      Lista para usarse en una sesión
                    </p>
                  ) : (
                    <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                      {table.pendingRequirements.map((req) => (
                        <li key={req} className="flex items-start gap-1.5">
                          <AlertTriangle
                            className="mt-0.5 size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          {req}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <TableFormDialog
                        table={{
                          id: table.id,
                          code: table.code,
                          name: table.name,
                          smallBlind: table.smallBlind,
                          bigBlind: table.bigBlind,
                          sortOrder: table.sortOrder,
                          chipSetId: table.chipSet.id,
                        }}
                        chipSets={
                          chipSetOptions.some((o) => o.id === table.chipSet.id)
                            ? chipSetOptions
                            : [
                                {
                                  id: table.chipSet.id,
                                  name: table.chipSet.name,
                                  code: table.chipSet.code,
                                },
                                ...chipSetOptions,
                              ]
                        }
                      />
                      <StatusToggleButton
                        url={`/api/tables/${table.id}/status`}
                        isActive={table.isActive}
                        entityLabel={table.name}
                        deactivateWarning="La mesa no podrá usarse en nuevas sesiones. Su historial y configuración se conservan."
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground text-xs">
        Configurar una mesa no crea una caja: todo el dinero pasa por la Caja
        Central. Las sesiones guardarán una fotografía de las ciegas y del juego
        de fichas usados, así que los cambios aquí no alteran el historial.
      </p>
    </div>
  )
}
