import { Card, CardContent } from "@/components/ui/card"
import { SPECIAL_BASE } from "@/modules/special-operations/special.constants"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/modules/admin/components/admin-ui"
import { RedemptionCreateForm } from "@/modules/special-operations/components/special-actions"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Registrar canje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function NewRedemptionPage() {
  await requirePagePermission(
    PERMISSIONS.SPECIAL_OPS_OPERATE,
    `${SPECIAL_BASE}/canjes`
  )
  const [players, sessions] = await Promise.all([
    prisma.player.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      take: 500,
      select: { id: true, name: true },
    }),
    prisma.pokerSession.findMany({
      where: { status: { in: ["OPEN", "CLOSING", "CLOSED"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, folio: true },
    }),
  ])
  return (
    <>
      <BackLink href={`${SPECIAL_BASE}/canjes`} label="Canjes" />
      <PageHeader
        title="Registrar canje posterior"
        description="Paso 1: registrar la presentación. Un socio valida el valor; después se reciben las fichas y se paga."
      />
      <Card>
        <CardContent>
          <RedemptionCreateForm players={players} sessions={sessions} />
        </CardContent>
      </Card>
    </>
  )
}
