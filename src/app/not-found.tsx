import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-muted-foreground text-sm font-medium">Error 404</p>
      <h1 className="text-2xl font-semibold">Página no encontrada</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        La página que buscas no existe o fue movida.
      </p>
      <Link href="/" className={buttonVariants()}>
        Volver al inicio
      </Link>
    </div>
  )
}
