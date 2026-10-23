import type { ReactNode } from "react"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { BankingNav } from "@/modules/banking/components/banking-nav"
import { BANKING_BASE } from "@/modules/banking/components/labels"

/**
 * Bancaje (Módulo 17) — sección PRIVADA. Solo con `banking:read`; nada de
 * esto se muestra en la mesa ni en vistas compartidas. Cada acción vuelve a
 * autorizar en el servidor (las aprobaciones DIGITALES exigen
 * `banking:approve`: PARTNER o SUPERADMIN).
 */
export default async function BankingLayout({
  children,
}: {
  children: ReactNode
}) {
  await requirePagePermission(PERMISSIONS.BANKING_READ, BANKING_BASE)
  return (
    <div className="space-y-4" data-testid="banking-private">
      <BankingNav />
      {children}
    </div>
  )
}
