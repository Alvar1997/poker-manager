import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { formatDateTime } from "@/lib/format"
import { GeneralSettingsForm } from "@/modules/settings/components/general-settings-form"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import {
  DATE_FORMAT_LABEL,
  TIME_FORMAT_LABEL,
} from "@/modules/settings/settings.schemas"
import { getBusinessSettings } from "@/modules/settings/settings.service"

export const metadata = { title: "Datos generales — Poker Manager" }

export default async function GeneralSettingsPage() {
  const section = settingsSection("general")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const settings = await getBusinessSettings()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SettingsPageHeader section={section} canManage={canManage} />

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Parámetros fijos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadOnlyList
            items={[
              {
                label: "Moneda",
                value: settings.currency,
                hint: "Fija en esta versión",
              },
              {
                label: "Zona horaria",
                value: settings.timezone,
                hint: "Fija en esta versión",
              },
              ...(canManage
                ? []
                : [
                    {
                      label: "Nombre del negocio",
                      value: settings.businessName,
                    },
                    {
                      label: "Nombre para mostrar",
                      value: settings.displayName ?? "—",
                    },
                    {
                      label: "Formato de fecha",
                      value: DATE_FORMAT_LABEL[settings.dateFormat],
                    },
                    {
                      label: "Formato de hora",
                      value: TIME_FORMAT_LABEL[settings.timeFormat],
                    },
                  ]),
              {
                label: "Última modificación",
                value: formatDateTime(settings.updatedAt),
                hint: settings.updatedBy
                  ? `por ${settings.updatedBy.name}`
                  : undefined,
              },
            ]}
          />
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Datos del negocio
            </CardTitle>
          </CardHeader>
          <CardContent>
            <GeneralSettingsForm settings={settings} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
