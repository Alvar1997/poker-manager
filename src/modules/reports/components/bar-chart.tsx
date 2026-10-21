import { cn } from "@/lib/utils"
import { formatMXN } from "@/modules/cash/components/format"
import type { Series } from "@/modules/reports/comparative-report.service"

/**
 * Gráfica de barras horizontales (sin dependencias): legible en celular y
 * accesible (cada barra tiene su valor en texto). Siempre muestra unidad,
 * periodo y definición del indicador. Los valores negativos (p. ej.
 * diferencias de arqueo) se pintan en rojo.
 */
export function BarChart({ series }: { series: Series }) {
  const values = series.points.map((p) => Math.abs(Number(p.value)))
  const max = Math.max(0, ...values)
  const money = series.unit === "MXN" || series.unit === "MXN nominal"
  return (
    <figure
      className="space-y-2 rounded-lg border p-3"
      data-testid={`chart-${series.id}`}
    >
      <figcaption>
        <p className="text-sm font-medium">{series.title}</p>
        <p className="text-muted-foreground text-xs">
          Unidad: {series.unit} · Periodo: {series.period}
        </p>
        <p className="text-muted-foreground text-xs">{series.definition}</p>
      </figcaption>
      {series.points.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Sin datos en el periodo.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {series.points.map((p) => {
            const v = Number(p.value)
            const pct = max > 0 ? Math.max(1, (Math.abs(v) / max) * 100) : 0
            return (
              <li key={p.key} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate">{p.label}</span>
                  <span className="tabular-nums">
                    {money ? formatMXN(p.value) : p.value}
                  </span>
                </div>
                <div
                  className="bg-muted h-2 w-full overflow-hidden rounded"
                  role="presentation"
                >
                  <div
                    className={cn(
                      "h-2 rounded",
                      v < 0 ? "bg-destructive" : "bg-primary"
                    )}
                    style={{ width: v === 0 ? 0 : `${pct}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </figure>
  )
}
