import { ShieldX } from "lucide-react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata = {
  title: "Acceso denegado — Poker Manager",
}

export default function AccessDeniedPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <ShieldX className="text-destructive size-12" aria-hidden="true" />
      <p className="text-muted-foreground text-sm font-medium">Error 403</p>
      <h1 className="text-2xl font-semibold">Acceso denegado</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        Tu rol no tiene permiso para abrir esta función. Si crees que es un
        error, pide al administrador que revise tu cuenta. El intento quedó
        registrado.
      </p>
      <Link
        href="/dashboard"
        className={cn(buttonVariants({ size: "lg" }), "h-11 md:h-9")}
      >
        Volver al inicio
      </Link>
    </div>
  )
}
