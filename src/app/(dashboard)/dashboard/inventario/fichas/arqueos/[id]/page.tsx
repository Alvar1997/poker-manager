import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  COUNT_TYPE_LABEL,
  CountStatusBadges,
} from "@/modules/inventory/components/count-status"
import { CountWorkspace } from "@/modules/inventory/components/count-workspace"
import { INVENTORY_BASE } from "@/modules/inventory/components/inventory-nav"
import { getStockCount } from "@/modules/inventory/stock-count.service"

export const metadata = { title: "Arqueo — Poker Manager" }

export default async function CountPage({
  params,
}: PageProps<"/dashboard/inventario/fichas/arqueos/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.CHIPS_READ,
    `${INVENTORY_BASE}/arqueos`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]+$/.test(id)) notFound()
  const count = await getStockCount(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`${INVENTORY_BASE}/arqueos`}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Arqueos
      </Link>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">
          Arqueo {COUNT_TYPE_LABEL[count.countType].toLowerCase()} ·{" "}
          {count.chipSet.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {count.container.name} ({count.container.code}) · iniciado{" "}
          {formatDateTime(count.createdAt)}
          {count.confirmedAt
            ? ` · confirmado ${formatDateTime(count.confirmedAt)} por ${count.confirmedBy?.name ?? "—"}`
            : ""}
        </p>
        <CountStatusBadges
          status={count.status}
          reconciliationStatus={count.reconciliationStatus}
        />
        {count.reconciliationStatus === "RECONCILED" ? (
          <p className="text-sm">
            Conciliado{" "}
            {count.reconciledAt ? formatDateTime(count.reconciledAt) : ""} por{" "}
            {count.reconciledBy?.name ?? "—"}. Motivo:{" "}
            {count.reconciliationReason}
          </p>
        ) : null}
      </div>
      <CountWorkspace
        key={`${count.status}-${count.inventoryVersion}-${count.reconciliationStatus}`}
        count={count}
        canOperate={can(user, PERMISSIONS.CHIPS_OPERATE)}
      />
    </div>
  )
}
