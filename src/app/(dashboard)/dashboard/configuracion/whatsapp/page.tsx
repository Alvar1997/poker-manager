import { Clock, Info } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { formatDateTime } from "@/lib/format"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { getWhatsAppStatus } from "@/modules/settings/settings.service"

export const metadata = { title: "WhatsApp — Poker Manager" }

/**
 * Estado de solo lectura. No hay botones de conectar, verificar ni enviar:
 * la integración real se construirá en el Módulo 13.
 */
export default async function WhatsAppSettingsPage() {
  const section = settingsSection("whatsapp")
  const user = await requirePagePermission(section.permission, section.href)
  const status = await getWhatsAppStatus()
  const pending = status.configurationStatus === "PENDING_CONFIGURATION"

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SettingsPageHeader
        section={section}
        canManage={can(user, PERMISSIONS.SETTINGS_MANAGE)}
      />

      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={2}
            className="flex flex-wrap items-center gap-2"
          >
            Estado de la integración
            <Badge
              data-testid="whatsapp-status"
              variant="outline"
              className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
            >
              <Clock aria-hidden="true" />
              {pending ? "Pendiente de configuración" : "Configurada"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadOnlyList
            items={[
              { label: "Proveedor", value: "Meta WhatsApp Cloud API" },
              {
                label: "Estado",
                value: pending ? "Pendiente de configuración" : "Configurada",
              },
              {
                label: "Número emisor",
                value: status.senderPhone ?? "No configurado",
              },
              {
                label: "Integración activa",
                value: status.enabled ? "Sí" : "No",
              },
              { label: "Plantillas", value: "Pendientes" },
              {
                label: "Última verificación",
                value: status.lastVerifiedAt
                  ? formatDateTime(status.lastVerifiedAt)
                  : "No disponible",
              },
              {
                label: "Credenciales del servidor",
                value: status.credentialsPresent ? "Presentes" : "No definidas",
                hint: "Variables de entorno WHATSAPP_*; nunca se guardan en la base de datos",
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex gap-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p data-testid="whatsapp-notice">{status.notice}</p>
            <p className="text-muted-foreground">
              Cuando se configure, la app enviará al jugador un mensaje después
              de confirmar cada compra o recompra a crédito. Mientras tanto, no
              se envía ningún mensaje y el resto del sistema funciona con
              normalidad.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
