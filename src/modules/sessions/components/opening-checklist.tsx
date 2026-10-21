import { CheckCircle2, CircleDashed, XCircle } from "lucide-react"

import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { OpeningChecklist } from "@/modules/sessions/opening.service"

/** Presenta el checklist calculado por el SERVIDOR (no se edita en el navegador). */
export function OpeningChecklistView({
  checklist,
}: {
  checklist: OpeningChecklist
}) {
  const done = checklist.steps.filter((s) => s.status === "DONE").length
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Checklist de apertura</span>
          <span
            className="text-muted-foreground"
            data-testid="checklist-progress"
          >
            {done} de {checklist.steps.length}
          </span>
        </div>
        <div
          className="bg-muted h-2 overflow-hidden rounded-full"
          aria-hidden="true"
        >
          <div
            className="h-full bg-emerald-600 transition-all"
            style={{ width: `${(done / checklist.steps.length) * 100}%` }}
          />
        </div>
      </div>
      <ol className="space-y-2" data-testid="opening-checklist">
        {checklist.steps.map((s) => {
          const Icon =
            s.status === "DONE"
              ? CheckCircle2
              : s.status === "BLOCKED"
                ? XCircle
                : CircleDashed
          return (
            <li
              key={s.id}
              className="flex items-start gap-2 text-sm"
              data-testid="checklist-step"
              data-status={s.status}
              data-step={s.id}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  s.status === "DONE" && "text-emerald-600",
                  s.status === "BLOCKED" && "text-destructive",
                  s.status === "PENDING" && "text-muted-foreground"
                )}
                aria-label={
                  s.status === "DONE"
                    ? "Cumplido"
                    : s.status === "BLOCKED"
                      ? "Bloqueado"
                      : "Pendiente"
                }
              />
              <div className="min-w-0">
                <p
                  className={cn(s.status === "DONE" && "text-muted-foreground")}
                >
                  {s.label}
                </p>
                {s.message ? (
                  <p
                    className={cn(
                      "text-xs",
                      s.status === "BLOCKED"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    )}
                  >
                    {s.message}
                  </p>
                ) : null}
                {s.status === "DONE" && (s.completedAt || s.completedBy) ? (
                  <p className="text-muted-foreground text-xs">
                    {s.completedBy?.name ?? ""}
                    {s.completedAt ? ` · ${formatDateTime(s.completedAt)}` : ""}
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
