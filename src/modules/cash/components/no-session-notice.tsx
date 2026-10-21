import { CircleSlash } from "lucide-react"

/** Aviso cuando no hay sesión operativa (Módulo 06): no se registra dinero. */
export function NoSessionNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div
      role="status"
      data-testid="no-session"
      className="flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
    >
      <CircleSlash
        className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="font-medium">No hay una sesión operativa abierta.</p>
        <p className="text-muted-foreground">
          {children ??
            "Las entradas, salidas y arqueos de efectivo se habilitan al abrir una sesión (Módulo 06). Cada sesión inicia con $0.00 en caja."}
        </p>
      </div>
    </div>
  )
}
