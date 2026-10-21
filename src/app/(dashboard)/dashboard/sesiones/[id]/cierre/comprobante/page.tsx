import { notFound } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { getClosureReport } from "@/modules/closure/closure.service"
import { SESSIONS_BASE } from "@/modules/sessions/components/session-ui"
import { ReceiptActions } from "@/modules/signatures/components/signature-actions"
import { receiptDate } from "@/modules/signatures/receipt.content"

import { loadSession } from "../../../load-session"
import { ClosureHeader } from "../closure-header"

export const metadata = { title: "Comprobante de cierre — Poker Manager" }

export default async function ClosureReportPage({
  params,
}: PageProps<"/dashboard/sesiones/[id]/cierre/comprobante">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.SESSIONS_READ,
    `${SESSIONS_BASE}/${id}/cierre/comprobante`
  )
  const session = await loadSession(id, user)
  const report = await getClosureReport(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const c = report.content

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <ClosureHeader
        sessionId={id}
        folio={session.folio}
        status={session.status}
        title="Comprobante de cierre"
        current="comprobante"
      />
      <Card className="bg-white text-slate-900" data-testid="closure-report">
        <CardContent className="space-y-3 pt-4 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-slate-500">
                Poker Manager · Comprobante de cierre de sesión
              </p>
              <p className="font-mono text-2xl font-semibold">{report.title}</p>
              <p className="text-xs text-slate-500">
                {receiptDate(c.session.closedAt)}
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border-2 px-3 py-0.5 text-xs font-medium",
                report.intact
                  ? "border-emerald-700 text-emerald-700"
                  : "border-red-700 text-red-700"
              )}
              data-testid="closure-report-kind"
            >
              {c.kind === "NO_ACTIVITY"
                ? "Cerrada sin actividad"
                : "Sesión cerrada"}
            </span>
          </div>
          <dl className="divide-y divide-slate-100 border-t border-slate-200">
            {report.lines.map((l, i) => (
              <div
                key={`${i}-${l.label}`}
                className="flex items-baseline justify-between gap-3 py-1.5"
              >
                <dt className="text-slate-600">{l.label}</dt>
                <dd
                  className={cn(
                    "text-right tabular-nums",
                    l.strong && "font-semibold"
                  )}
                >
                  {l.value}
                </dd>
              </div>
            ))}
          </dl>
          {!report.intact ? (
            <p className="text-xs text-red-700" role="alert">
              El contenido no coincide con su huella registrada.
            </p>
          ) : null}
          <p className="text-xs text-slate-500">
            Comprobante inmutable: los movimientos posteriores (transferencias,
            pagos, abonos o canjes de fichas) se consultan en sus historiales.
          </p>
        </CardContent>
      </Card>
      <ReceiptActions
        purchaseId={id}
        folio={report.title}
        text={report.text}
        imageUrl={`/api/sessions/${id}/closure/report/image`}
        shareEventsUrl={`/api/sessions/${id}/closure/report/share-events`}
        filename={`cierre-${c.session.folio}.png`}
      />
    </div>
  )
}
