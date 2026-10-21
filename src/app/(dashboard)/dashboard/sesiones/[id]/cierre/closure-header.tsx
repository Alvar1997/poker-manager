import { ClosureNav } from "@/modules/closure/components/closure-ui"
import {
  SESSIONS_BASE,
  SessionStatusBadge,
} from "@/modules/sessions/components/session-ui"
import type { SessionStatusValue } from "@/modules/sessions/session.state"

import { BackLink } from "../../back-link"

/** Encabezado común de las pantallas del cierre. */
export function ClosureHeader({
  sessionId,
  folio,
  status,
  title,
  current,
  description,
}: {
  sessionId: string
  folio: string
  status: SessionStatusValue
  title: string
  current?: string
  description?: string
}) {
  return (
    <div className="space-y-3">
      <BackLink
        href={
          current
            ? `${SESSIONS_BASE}/${sessionId}/cierre`
            : `${SESSIONS_BASE}/${sessionId}`
        }
        label={current ? "Panel de cierre" : `Sesión ${folio}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {title} · <span className="font-mono">{folio}</span>
        </h1>
        <SessionStatusBadge status={status} />
      </div>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
      <ClosureNav sessionId={sessionId} current={current} />
    </div>
  )
}
