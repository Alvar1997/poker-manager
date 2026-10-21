import { ArrowLeft } from "lucide-react"
import Link from "next/link"

import { CASH_BASE } from "@/modules/cash/components/format"

export function BackToCash({
  href = CASH_BASE,
  label = "Caja central",
}: {
  href?: string
  label?: string
}) {
  return (
    <Link
      href={href}
      className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {label}
    </Link>
  )
}
