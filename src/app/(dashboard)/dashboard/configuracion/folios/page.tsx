import { Lock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { formatDateTime } from "@/lib/format"
import { FolioEditDialog } from "@/modules/settings/components/folio-edit-dialog"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { listFolioSequences } from "@/modules/settings/folio.service"

export const metadata = { title: "Folios — Poker Manager" }

export default async function FoliosPage() {
  const section = settingsSection("folios")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const folios = await listFolioSequences()

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <SettingsPageHeader section={section} canManage={canManage} />

      <ul className="space-y-3">
        {folios.map((folio) => (
          <li key={folio.id}>
            <Card data-testid="folio-card">
              <CardContent className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{folio.label}</p>
                  <p className="text-sm">
                    Siguiente:{" "}
                    <code className="font-mono" data-testid="folio-preview">
                      {folio.preview}
                    </code>
                  </p>
                  {folio.lastIssuedAt ? (
                    <p className="text-muted-foreground text-xs">
                      Último emitido: {formatDateTime(folio.lastIssuedAt)}
                    </p>
                  ) : null}
                </div>
                {folio.locked ? (
                  <Badge variant="outline" className="gap-1">
                    <Lock aria-hidden="true" />
                    En uso
                  </Badge>
                ) : canManage ? (
                  <FolioEditDialog
                    folio={folio}
                    fixedFormat={folio.documentType === "SESSION"}
                  />
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        Los folios se generan de forma atómica, no se repiten ni se reutilizan
        (un documento cancelado conserva su folio). El formato solo puede
        cambiarse antes de emitir el primero. Ningún folio se emite en este
        módulo: los usarán sesiones, compras, abonos y liquidaciones.
      </p>
    </div>
  )
}
