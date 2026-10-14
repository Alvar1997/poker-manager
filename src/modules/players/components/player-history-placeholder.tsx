import { Clock } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const SECTIONS = [
  { id: "sessions", title: "Sesiones", module: "sesiones" },
  { id: "purchases", title: "Compras", module: "compras" },
  { id: "rebuys", title: "Recompras", module: "compras y recompras" },
  { id: "credits", title: "Créditos", module: "créditos" },
  { id: "payments", title: "Abonos", module: "deudas y abonos" },
  { id: "settlements", title: "Liquidaciones", module: "liquidaciones" },
] as const

/**
 * Secciones de historial preparadas. NO muestra montos (ni ceros): esos
 * módulos aún no existen y no se inventan operaciones.
 */
export function PlayerHistoryPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Historial
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y" data-testid="history-placeholders">
          {SECTIONS.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-2.5 text-sm">
              <Clock
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="text-muted-foreground text-xs">
                  Disponible cuando se implemente el módulo de {s.module}.
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
