import type { ReactNode } from "react"

import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { SpecialNav } from "@/modules/special-operations/components/special-nav"

/**
 * Operaciones especiales (Módulo 16): canjes posteriores, reversos de
 * compras, correcciones de liquidaciones y devolución de fondos no
 * aplicados. Los tres roles consultan; cada acción vuelve a autorizar en
 * el servidor (CASHIER solicita y ejecuta lo autorizado; nunca autoriza).
 */
export default async function SpecialOperationsLayout({
  children,
}: {
  children: ReactNode
}) {
  await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_READ,
    "/dashboard/operaciones-especiales"
  )
  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <SpecialNav />
      {children}
    </div>
  )
}
