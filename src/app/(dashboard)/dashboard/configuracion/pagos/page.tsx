import { Banknote, CreditCard, Info, Landmark } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { settingsSection } from "@/config/settings-sections"
import { listPaymentMethods } from "@/modules/payments/payment-method.service"
import { ActiveBadge } from "@/modules/settings/components/active-badge"
import { PaymentMethodRenameDialog } from "@/modules/settings/components/payment-method-rename-dialog"
import { SettingsPageHeader } from "@/modules/settings/components/settings-page-header"
import { StatusToggleButton } from "@/modules/settings/components/status-toggle-button"

export const metadata = { title: "Métodos de pago — Poker Manager" }

const ICON = {
  CASH: Banknote,
  BANK_TRANSFER: Landmark,
  CARD_DEBIT: CreditCard,
  CARD_CREDIT: CreditCard,
} as const

export default async function PaymentMethodsPage() {
  const section = settingsSection("pagos")
  const user = await requirePagePermission(section.permission, section.href)
  const canManage = can(user, PERMISSIONS.SETTINGS_MANAGE)
  const methods = await listPaymentMethods({
    includeInactive: can(user, PERMISSIONS.SETTINGS_READ),
  })

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <SettingsPageHeader section={section} canManage={canManage} />

      <ul className="space-y-3">
        {methods.map((method) => {
          const Icon = ICON[method.code]
          return (
            <li key={method.id}>
              <Card data-testid="payment-method-card">
                <CardContent className="flex flex-wrap items-center gap-3">
                  <Icon className="size-5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{method.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {method.code}
                    </p>
                  </div>
                  <ActiveBadge isActive={method.isActive} />
                  {canManage ? (
                    <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                      <PaymentMethodRenameDialog method={method} />
                      <StatusToggleButton
                        url={`/api/payment-methods/${method.id}`}
                        isActive={method.isActive}
                        entityLabel={method.name}
                        deactivateWarning="No se ofrecerá en nuevas operaciones. Su historial se conserva. Debe quedar al menos un método activo."
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>

      <Card>
        <CardContent className="text-muted-foreground flex gap-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <ul className="list-disc space-y-1 pl-4">
            <li>
              El efectivo, las transferencias y los cobros con terminal se
              contabilizan por separado.
            </li>
            <li>
              Las <strong>tarjetas de débito y crédito</strong> se cobran en la
              terminal física: solo un cobro aprobado cuenta como pago y queda
              «por liquidar» hasta que la terminal deposite en el banco. Nunca
              se guardan números de tarjeta, CVV ni PIN.
            </li>
            <li>
              Un <strong>pago mixto</strong> no es un método: es una compra con
              varios componentes de pago.
            </li>
            <li>
              El <strong>crédito</strong> no es un método de pago: es una deuda
              por cobrar y nunca se suma al dinero disponible.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
