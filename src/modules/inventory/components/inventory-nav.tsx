import {
  ArrowDownToLine,
  ClipboardCheck,
  History,
  PackageMinus,
  SlidersHorizontal,
} from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const INVENTORY_BASE = "/dashboard/inventario/fichas"

const LINKS = [
  {
    href: `${INVENTORY_BASE}/entrada`,
    label: "Entrada",
    icon: ArrowDownToLine,
  },
  { href: `${INVENTORY_BASE}/baja`, label: "Baja", icon: PackageMinus },
  {
    href: `${INVENTORY_BASE}/ajustes`,
    label: "Ajuste",
    icon: SlidersHorizontal,
  },
  { href: `${INVENTORY_BASE}/arqueos`, label: "Arqueos", icon: ClipboardCheck },
  {
    href: `${INVENTORY_BASE}/movimientos`,
    label: "Movimientos",
    icon: History,
  },
]

/** Accesos rápidos del inventario (botones grandes en celular). */
export function InventoryActions({ canOperate }: { canOperate: boolean }) {
  const links = canOperate
    ? LINKS
    : LINKS.filter((l) => l.label === "Movimientos" || l.label === "Arqueos")
  return (
    <nav
      aria-label="Acciones de inventario"
      className="grid grid-cols-2 gap-2 sm:grid-cols-5"
    >
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
        >
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  )
}
