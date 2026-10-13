import { Info } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { formatDateTime } from "@/lib/format"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { CashBoxForm } from "@/modules/settings/components/cash-box-form"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { getCashBox } from "@/modules/settings/settings.service"

export const metadata = { title: "Caja central — Poker Manager" }

export default async function CashBoxPage() {
  const section = settingsSection("caja")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const box = await getCashBox()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SettingsPageHeader section={section} canManage={canManage} />

      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={2}
            className="flex items-center gap-2"
          >
            {box.name}{" "}
            <ActiveBadge
              isActive={box.isActive}
              activeLabel="Activa"
              inactiveLabel="Inactiva"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ReadOnlyList
            items={[
              { label: "Código", value: <code>{box.code}</code> },
              { label: "Moneda", value: box.currency },
              {
                label: "Saldo",
                value: "Se calculará con el libro de movimientos",
                hint: "Este módulo no registra dinero",
              },
              {
                label: "Última modificación",
                value: formatDateTime(box.updatedAt),
                hint: box.updatedBy ? `por ${box.updatedBy.name}` : undefined,
              },
            ]}
          />
          {canManage ? <CashBoxForm name={box.name} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="text-muted-foreground flex gap-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p>
              Es la <strong>única caja financiera</strong> del negocio: recibe y
              entrega el dinero de todas las mesas. No existen cajas por mesa y
              no debe confundirse con los juegos de fichas.
            </p>
            <p>
              Cada sesión inicia con un <strong>fondo nuevo</strong> y al cierre
              se <strong>retira todo el efectivo</strong> tras el arqueo final.
              Ver Reglas operativas.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
