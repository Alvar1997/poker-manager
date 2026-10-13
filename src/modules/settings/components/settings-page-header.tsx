import { ArrowLeft, Eye } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import {
  SETTINGS_BASE_PATH,
  type SettingsSection,
} from "@/config/settings-sections"

/** Encabezado común de cada sección de Configuración. */
export function SettingsPageHeader({
  section,
  canManage,
  actions,
}: {
  section: SettingsSection
  canManage: boolean
  actions?: ReactNode
}) {
  const Icon = section.icon
  return (
    <div className="space-y-3">
      <Link
        href={SETTINGS_BASE_PATH}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Configuración
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-1 size-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{section.title}</h1>
            <p className="text-muted-foreground text-sm">
              {section.description}
            </p>
          </div>
        </div>
        {actions}
      </div>
      {!canManage ? (
        <Badge
          variant="outline"
          className="gap-1"
          data-testid="read-only-badge"
        >
          <Eye aria-hidden="true" />
          Solo consulta
        </Badge>
      ) : null}
    </div>
  )
}
