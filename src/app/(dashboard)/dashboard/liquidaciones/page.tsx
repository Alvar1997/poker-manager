import { HandCoins } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { cn } from "@/lib/utils"
import {
  SETTLEMENT_STATUS_LABEL,
  SETTLEMENTS_BASE,
  SettlementList,
} from "@/modules/settlements/components/settlement-ui"
import { SETTLEMENT_STATUSES } from "@/modules/settlements/settlement.schemas"
import { listSettlements } from "@/modules/settlements/settlement.service"

export const metadata = { title: "Liquidaciones — Poker Manager" }

export default async function SettlementsPage({
  searchParams,
}: PageProps<"/dashboard/liquidaciones">) {
  await requirePagePermission(PERMISSIONS.SETTLEMENTS_READ, SETTLEMENTS_BASE)
  const sp = await searchParams
  const status = SETTLEMENT_STATUSES.find((s) => s === sp.status)
  const list = await listSettlements({ status, page: 1, pageSize: 50 })
  const filters: { label: string; value?: string }[] = [
    { label: "Todas" },
    ...(
      [
        "PENDING_PAYOUT",
        "READY_FOR_CONFIRMATION",
        "DRAFT",
        "COMPLETED",
      ] as const
    ).map((s) => ({ label: SETTLEMENT_STATUS_LABEL[s], value: s })),
  ]
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <HandCoins className="size-5" aria-hidden />
          Liquidaciones
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`${SETTLEMENTS_BASE}/pendientes`}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-11 md:h-9"
            )}
            data-testid="go-pending-payouts"
          >
            Pagos pendientes
          </Link>
          <Link
            href={`${SETTLEMENTS_BASE}/nueva`}
            className={cn(buttonVariants(), "h-11 md:h-9")}
          >
            Liquidar jugador
          </Link>
        </div>
      </div>
      <p className="text-muted-foreground text-sm">
        El jugador devuelve sus fichas por valor nominal, firma su liquidación y
        recibe su pago (completo, parcial o pendiente). La compensación de deuda
        es opcional y la decide el cajero.
      </p>
      <nav
        className="flex gap-2 overflow-x-auto pb-1"
        aria-label="Filtrar por estado"
      >
        {filters.map((f) => (
          <Link
            key={f.label}
            href={
              f.value
                ? `${SETTLEMENTS_BASE}?status=${f.value}`
                : SETTLEMENTS_BASE
            }
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm",
              status === f.value && "border-primary bg-primary/10 font-medium"
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      <SettlementList items={list.items} />
    </div>
  )
}
