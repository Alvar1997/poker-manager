import { businessDay } from "@/modules/reports/report.math"

/**
 * Política de retención (pura, parametrizable). Recomendación inicial:
 * diarios 30 días + el primer respaldo exitoso de cada mes durante 6 meses.
 * Nunca se elimina el respaldo exitoso más reciente. Los fallidos se
 * conservan como registro (sus archivos parciales pueden eliminarse al
 * vencer el periodo diario).
 */
export function retentionPlan(
  backups: { id: string; at: Date; ok: boolean }[],
  opts: { dailyDays: number; monthlyMonths: number; now: Date }
) {
  const dayMs = 24 * 3600 * 1000
  const sorted = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime())
  const keep = new Set<string>()
  const newestOk = sorted.find((b) => b.ok)
  if (newestOk) keep.add(newestOk.id)
  for (const b of sorted)
    if (opts.now.getTime() - b.at.getTime() <= opts.dailyDays * dayMs)
      keep.add(b.id)
  // Primer exitoso de cada mes dentro de la ventana mensual.
  const months = new Map<string, { id: string; at: Date }>()
  for (const b of sorted) {
    if (!b.ok) continue
    const month = businessDay(b.at).slice(0, 7)
    const prev = months.get(month)
    if (!prev || b.at < prev.at) months.set(month, { id: b.id, at: b.at })
  }
  const limit = new Date(opts.now)
  limit.setUTCMonth(limit.getUTCMonth() - opts.monthlyMonths)
  for (const m of months.values()) if (m.at >= limit) keep.add(m.id)
  return {
    keep: sorted.filter((b) => keep.has(b.id)).map((b) => b.id),
    prune: sorted.filter((b) => !keep.has(b.id)).map((b) => b.id),
  }
}
