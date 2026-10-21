import { Plus } from "lucide-react"
import Link from "next/link"

import { NativeSelect } from "@/components/shared/native-select"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { cn } from "@/lib/utils"
import {
  PURCHASES_BASE,
  PurchaseList,
} from "@/modules/purchases/components/purchase-ui"
import { purchasesQuerySchema } from "@/modules/purchases/purchase.schemas"
import { listPurchases } from "@/modules/purchases/purchase.service"

export const metadata = { title: "Compras y recompras — Poker Manager" }

export default async function PurchasesPage({
  searchParams,
}: PageProps<"/dashboard/compras">) {
  const user = await requirePagePermission(
    PERMISSIONS.PURCHASES_READ,
    PURCHASES_BASE
  )
  const raw = Object.fromEntries(
    Object.entries(await searchParams).filter(
      ([, v]) => typeof v === "string" && v !== ""
    )
  )
  const parsed = purchasesQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : purchasesQuerySchema.parse({})
  const result = await listPurchases(query)
  const value = (k: string) =>
    typeof raw[k] === "string" ? String(raw[k]) : ""

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Compras y recompras</h1>
          <p className="text-muted-foreground text-sm">
            Por importe nominal. Los saldos por cobrar se derivan de los pagos
            realmente confirmados.
          </p>
        </div>
        {can(user, PERMISSIONS.PURCHASES_CREATE) ? (
          <Link
            href={`${PURCHASES_BASE}/nueva`}
            className={cn(buttonVariants(), "h-11 w-full sm:w-auto md:h-9")}
            data-testid="new-purchase"
          >
            <Plus />
            Nueva compra
          </Link>
        ) : null}
      </div>

      <Card>
        <CardContent>
          <form
            method="get"
            className="grid grid-cols-2 gap-3 md:grid-cols-4"
            aria-label="Filtros de compras"
          >
            <div className="space-y-1">
              <Label htmlFor="status">Estado</Label>
              <NativeSelect
                id="status"
                name="status"
                defaultValue={value("status")}
              >
                <option value="">Todos</option>
                <option value="DRAFT">En preparación</option>
                <option value="READY_FOR_DELIVERY">Fichas apartadas</option>
                <option value="CONFIRMED">Entregadas</option>
                <option value="CANCELLED">Canceladas</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="purchaseType">Tipo</Label>
              <NativeSelect
                id="purchaseType"
                name="purchaseType"
                defaultValue={value("purchaseType")}
              >
                <option value="">Todos</option>
                <option value="INITIAL_PURCHASE">Compra inicial</option>
                <option value="REBUY">Recompra</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="method">Método</Label>
              <NativeSelect
                id="method"
                name="method"
                defaultValue={value("method")}
              >
                <option value="">Todos</option>
                <option value="CASH">Efectivo</option>
                <option value="BANK_TRANSFER">Transferencia</option>
                <option value="CARD_DEBIT">Débito</option>
                <option value="CARD_CREDIT">Crédito (tarjeta)</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="withCredit">Crédito</Label>
              <NativeSelect
                id="withCredit"
                name="withCredit"
                defaultValue={value("withCredit")}
              >
                <option value="">Todas</option>
                <option value="true">Generaron crédito</option>
                <option value="false">Pagadas al entregar</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">Desde</Label>
              <Input
                id="from"
                name="from"
                type="date"
                className="h-11 md:h-9"
                defaultValue={value("from")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">Hasta</Label>
              <Input
                id="to"
                name="to"
                type="date"
                className="h-11 md:h-9"
                defaultValue={value("to")}
              />
            </div>
            <div className="col-span-2 flex items-end gap-2">
              <Button type="submit" variant="outline" className="h-11 md:h-9">
                Filtrar
              </Button>
              <Link
                href={PURCHASES_BASE}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-11 md:h-9"
                )}
              >
                Limpiar
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs" data-testid="purchase-total">
        {result.total} compra{result.total === 1 ? "" : "s"}
      </p>
      <PurchaseList items={result.items} />
      {result.totalPages > 1 ? (
        <nav className="flex justify-between text-sm" aria-label="Paginación">
          {query.page > 1 ? (
            <Link
              href={`?${new URLSearchParams({ ...raw, page: String(query.page - 1) } as Record<string, string>)}`}
            >
              Anterior
            </Link>
          ) : (
            <span />
          )}
          {query.page < result.totalPages ? (
            <Link
              href={`?${new URLSearchParams({ ...raw, page: String(query.page + 1) } as Record<string, string>)}`}
            >
              Siguiente
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  )
}
