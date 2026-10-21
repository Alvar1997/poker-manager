import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  CreditCard,
  History,
  Landmark,
} from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CASH_BASE } from "@/modules/cash/components/format"

const LINKS = [
  { href: `${CASH_BASE}/entrada`, label: "Entrada", icon: ArrowDownToLine },
  { href: `${CASH_BASE}/salida`, label: "Salida", icon: ArrowUpFromLine },
  {
    href: `${CASH_BASE}/transferencias`,
    label: "Transferencias",
    icon: Landmark,
  },
  { href: `${CASH_BASE}/terminal`, label: "Terminal", icon: CreditCard },
  {
    href: `${CASH_BASE}/conciliaciones`,
    label: "Arqueos",
    icon: ClipboardCheck,
  },
  { href: `${CASH_BASE}/movimientos`, label: "Movimientos", icon: History },
]

/** Accesos rápidos de la caja. No existe acceso a "gastos": la caja no los registra. */
export function CashActions() {
  return (
    <nav
      aria-label="Acciones de caja"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
    >
      {LINKS.map(({ href, label, icon: Icon }) => (
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
