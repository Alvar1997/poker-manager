import { CheckCircle2, Lock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { getOperationalSettings } from "@/modules/settings/settings.service"

export const metadata = { title: "Reglas operativas — Poker Manager" }

const INITIAL_LABEL = { ZERO_OPENING_BALANCE: "La caja abre en $0.00" }
const CLOSING_LABEL = { FULL_WITHDRAWAL: "Retiro total del efectivo al cierre" }

export default async function OperationalRulesPage() {
  const section = settingsSection("reglas")
  const user = await requirePagePermission(section.permission, section.href)
  const settings = await getOperationalSettings()

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <SettingsPageHeader
        section={section}
        canManage={can(user, PERMISSIONS.SETTINGS_MANAGE)}
      />

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Políticas de efectivo
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadOnlyList
            items={[
              {
                label: "Apertura",
                value: INITIAL_LABEL[settings.initialCashPolicy],
                hint: "Sin fondo inicial ni arrastre de la sesión anterior; antes de abrir se cuentan las fichas.",
              },
              {
                label: "Cierre",
                value: CLOSING_LABEL[settings.closingCashPolicy],
                hint: "Tras el arqueo final; el efectivo esperado queda en cero.",
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={2}
            className="flex items-center gap-2"
          >
            <Lock className="size-4" aria-hidden="true" />
            Reglas fijas del sistema
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            Son reglas de negocio de esta versión: no se pueden desactivar desde
            un formulario.
          </p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3" data-testid="operational-rules">
            {settings.rules.map((rule) => (
              <li key={rule.id} className="flex gap-3">
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{rule.title}</p>
                  <p className="text-muted-foreground text-sm">
                    {rule.description}
                  </p>
                  <Badge variant="outline" className="h-auto whitespace-normal">
                    Se aplica en: {rule.enforcedBy}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
