import { AlertTriangle, ArrowLeft, Briefcase } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  denominationTitle,
  formatChips,
  formatNominal,
} from "@/modules/inventory/components/format"
import {
  INVENTORY_BASE,
  InventoryActions,
} from "@/modules/inventory/components/inventory-nav"
import { getInventoryByChipSet } from "@/modules/inventory/inventory.service"

export const metadata = { title: "Inventario de fichas — Poker Manager" }

export default async function ChipSetInventoryPage({
  params,
}: PageProps<"/dashboard/inventario/fichas/[chipSetId]">) {
  const user = await requirePagePermission(
    PERMISSIONS.CHIPS_READ,
    INVENTORY_BASE
  )
  const { chipSetId } = await params
  if (!/^[A-Za-z0-9_-]+$/.test(chipSetId)) notFound()
  const inv = await getInventoryByChipSet(chipSetId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const canOperate = can(user, PERMISSIONS.CHIPS_OPERATE)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link
        href={INVENTORY_BASE}
        className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Inventario de fichas
      </Link>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{inv.chipSet.name}</h1>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Briefcase className="size-3.5" aria-hidden="true" />
          {inv.container
            ? `${inv.container.name} (${inv.container.code})`
            : "Sin ubicación"}
        </p>
      </div>

      {!inv.initialized ? (
        <Card>
          <CardContent className="space-y-3">
            <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Inventario pendiente de inicialización
            </p>
            <p className="text-muted-foreground text-sm">
              Cuenta físicamente todas las fichas y registra el inventario
              inicial. Se hace una sola vez para el inventario común; las
              correcciones posteriores se registran como ajustes.
            </p>
            {canOperate ? (
              inv.denominations.length > 0 ? (
                <Link
                  href={`${INVENTORY_BASE}/${inv.chipSet.id}/inicial`}
                  className={cn(buttonVariants(), "h-11 md:h-9")}
                >
                  Registrar inventario inicial
                </Link>
              ) : (
                <p className="text-sm">
                  Primero configura las denominaciones en Configuración →
                  Inventario de fichas.
                </p>
              )
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          <InventoryActions canOperate={canOperate} />
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                Resumen
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Saldo NOMINAL: fuente de verdad para compras (por importe). */}
              <dl
                className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"
                data-testid="inventory-totals"
              >
                {[
                  [
                    "Valor bajo custodia",
                    formatNominal(inv.nominal.custody),
                    "nominal-custody",
                  ],
                  [
                    "Disponible",
                    formatNominal(inv.nominal.available),
                    "nominal-available",
                  ],
                  [
                    "Reservado",
                    formatNominal(inv.nominal.reserved),
                    "nominal-reserved",
                  ],
                  [
                    "En circulación",
                    formatNominal(inv.nominal.circulation),
                    "nominal-circulation",
                  ],
                ].map(([label, value, testId]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground text-xs">{label}</dt>
                    <dd className="font-medium" data-testid={testId}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground pt-3 text-xs">
                Inicializado el {formatDateTime(inv.initializedAt!)}.{" "}
                {inv.pendingDifferences > 0
                  ? `${inv.pendingDifferences} arqueo(s) con diferencias por conciliar.`
                  : "Sin diferencias pendientes."}
              </p>
            </CardContent>
          </Card>
          <div className="space-y-1">
            <h2 className="font-medium">Composición por denominación</h2>
            {inv.nominal.breakdownExact ? (
              <p className="text-muted-foreground text-xs">
                Cantidades exactas según el último conteo y los movimientos con
                desglose.
              </p>
            ) : (
              <p
                className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                data-testid="breakdown-inexact"
              >
                <AlertTriangle
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                Referencia del último arqueo: las entregas y devoluciones se
                registran por importe, así que la composición exacta se conoce
                al volver a contar.
              </p>
            )}
          </div>
          <ul className="space-y-2" data-testid="denomination-stock">
            {inv.denominations.map((d) => (
              <li key={d.denominationId}>
                <Card data-testid="denomination-stock-row">
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{denominationTitle(d)}</p>
                      {d.isActive ? null : (
                        <Badge variant="outline">Inactiva</Badge>
                      )}
                    </div>
                    <dl className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Fichas</dt>
                        <dd
                          className="text-sm font-medium"
                          data-testid="stock-custody"
                        >
                          {formatChips(d.custody)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Bajas</dt>
                        <dd className="text-sm font-medium">
                          {formatChips(d.retired)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Valor</dt>
                        <dd className="text-sm font-medium">
                          {formatNominal(d.custodyNominal)}
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
