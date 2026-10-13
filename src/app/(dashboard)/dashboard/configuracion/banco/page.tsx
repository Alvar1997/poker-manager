import { AlertTriangle, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { formatDateTime } from "@/lib/format"
import { getBankAccount } from "@/modules/settings/bank-account.service"
import { BankAccountForm } from "@/modules/settings/components/bank-account-form"
import { ReadOnlyList } from "@/modules/settings/components/read-only-list"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"

export const metadata = { title: "Cuenta bancaria — Poker Manager" }

export default async function BankAccountPage() {
  const section = settingsSection("banco")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const account = await getBankAccount()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SettingsPageHeader section={section} canManage={canManage} />

      <Card>
        <CardHeader>
          <CardTitle
            role="heading"
            aria-level={2}
            className="flex flex-wrap items-center gap-2"
          >
            {account.name}
            {account.isConfigured ? (
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                Principal
              </Badge>
            ) : (
              <Badge
                variant="outline"
                data-testid="bank-pending"
                className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle aria-hidden="true" />
                Pendiente de captura
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadOnlyList
            items={[
              { label: "Banco", value: account.bankName ?? "No capturado" },
              {
                label: "Titular",
                value: account.accountHolder ?? "No capturado",
              },
              {
                label: "Número de cuenta",
                value: account.accountNumberMasked ?? "No capturado",
              },
              { label: "CLABE", value: account.clabeMasked ?? "No capturada" },
              {
                label: "Cuentas anteriores en historial",
                value: String(account.previousAccounts),
              },
              {
                label: "Última modificación",
                value: formatDateTime(account.updatedAt),
                hint: account.updatedBy
                  ? `por ${account.updatedBy.name}`
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
              Capturar o actualizar datos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BankAccountForm account={account} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="text-muted-foreground flex gap-3 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Es la única cuenta que recibe transferencias de todas las mesas;
              no pertenece a ninguna mesa.
            </li>
            <li>Su saldo no se reinicia al cerrar una sesión.</li>
            <li>
              Número de cuenta y CLABE se guardan cifrados y solo se muestran
              los últimos 4 dígitos.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
