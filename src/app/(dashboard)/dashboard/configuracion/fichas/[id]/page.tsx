import { ArrowLeft, Coins } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { EmptyState } from "@/components/shared/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { NotFoundError } from "@/lib/errors"
import { getChipSet, listDenominations } from "@/modules/chips/chip-set.service"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { ChipSetFormDialog } from "@/modules/settings/components/chip-set-form-dialog"
import { DenominationFormDialog } from "@/modules/settings/components/denomination-form-dialog"
import { StatusToggleButton } from "@/modules/settings/components/status-toggle-button"
import { entityIdSchema } from "@/modules/settings/settings.schemas"

export const metadata = { title: "Juego de fichas — Poker Manager" }

export default async function ChipSetDetailPage({
  params,
}: PageProps<"/dashboard/configuracion/fichas/[id]">) {
  const section = settingsSection("fichas")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const includeInactive = can(user, PERMISSIONS.SETTINGS_READ)

  const { id } = await params
  if (!entityIdSchema.safeParse(id).success) notFound()
  const set = await getChipSet(id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound()
    throw error
  })
  if (!set.isActive && !includeInactive) notFound()
  const denominations = await listDenominations(id, { includeInactive })

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href={section.href}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Juegos de fichas
      </Link>

      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={1}
            className="flex flex-wrap items-center gap-2"
          >
            {set.name} <ActiveBadge isActive={set.isActive} />
          </CardTitle>
          <p className="text-muted-foreground font-mono text-xs">{set.code}</p>
          {set.description ? (
            <p className="text-sm">{set.description}</p>
          ) : null}
          <p className="text-sm">
            {set.tables.length > 0
              ? `Asignado a: ${set.tables.map((t) => t.name).join(", ")}`
              : "Sin mesa asignada"}
          </p>
        </CardHeader>
        {canManage ? (
          <CardContent className="flex flex-wrap gap-2">
            <ChipSetFormDialog chipSet={set} />
            <StatusToggleButton
              url={`/api/chip-sets/${set.id}/status`}
              isActive={set.isActive}
              entityLabel={set.name}
              deactivateWarning="No podrá usarse en nuevas sesiones. Sus denominaciones e historial se conservan. Si está asignado a una mesa activa, primero reasigna la mesa."
            />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle role="heading" aria-level={2}>
            Denominaciones
          </CardTitle>
          {canManage ? (
            <DenominationFormDialog chipSetId={set.id} chipSetName={set.name} />
          ) : null}
        </CardHeader>
        <CardContent>
          {denominations.length === 0 ? (
            <EmptyState
              icon={Coins}
              title="Sin denominaciones"
              description="Este juego requiere configurar sus denominaciones reales antes de usarse en una sesión."
            />
          ) : (
            <ul className="divide-y" data-testid="denomination-list">
              {denominations.map((d) => (
                <li
                  key={d.id}
                  data-testid="denomination-row"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">${d.value}</p>
                    <p className="text-muted-foreground text-xs">
                      {[d.color, d.name].filter(Boolean).join(" · ") ||
                        "Sin color ni nombre"}
                    </p>
                  </div>
                  <ActiveBadge
                    isActive={d.isActive}
                    activeLabel="Activa"
                    inactiveLabel="Inactiva"
                  />
                  {canManage ? (
                    <div className="flex items-center gap-1">
                      <DenominationFormDialog
                        chipSetId={set.id}
                        chipSetName={set.name}
                        denomination={d}
                      />
                      <StatusToggleButton
                        url={`/api/denominations/${d.id}/status`}
                        isActive={d.isActive}
                        entityLabel={`denominación $${d.value}`}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
