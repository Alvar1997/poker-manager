import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  KeyValue,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { getCycle } from "@/modules/banking/banking-query.service"
import {
  ActionForm,
  DisburseForm,
  Panel,
  PrepareClosingForm,
  ResolvePayoutForm,
} from "@/modules/banking/components/banking-actions"
import {
  BANKING_API,
  BANKING_BASE,
  CLOSING_STATUS,
  CYCLE_STATUS,
  GAME_STATUS,
} from "@/modules/banking/components/labels"
import { formatMXN } from "@/modules/cash/components/format"

export const metadata = { title: "Ciclo de bancaje — Poker Manager" }
export const dynamic = "force-dynamic"

export default async function BankingCyclePage({
  params,
}: PageProps<"/dashboard/administracion/bancaje/ciclos/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/ciclos/${id}`
  )
  const canApprove = can(user, PERMISSIONS.BANKING_APPROVE)
  const canOperate = can(user, PERMISSIONS.BANKING_OPERATE)
  let c
  try {
    c = await getCycle(id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const p = c.provisional
  const ready =
    c.games.length === c.gamesPerCycle &&
    c.games.every((g) => g.status === "CONFIRMED") &&
    c.status !== "CLOSED"
  const review = c.closings.find((x) => x.status === "UNDER_REVIEW")
  return (
    <>
      <PageHeader
        title={`Ciclo #${c.number} · ${c.player.name}`}
        description="Cuatro jugadas (sesiones distintas). Los resultados brutos nunca se editan; el corte se aprueba digitalmente."
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          value={c.status}
          label={CYCLE_STATUS[c.status]}
          testId="cycle-status"
        />
        <Link
          href={`${BANKING_BASE}/jugadores/${c.player.id}`}
          className="text-sm underline"
        >
          Ver jugador
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Jugadas {c.games.length}/{c.gamesPerCycle}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={[
              "#",
              "Sesión",
              "Fecha operativa",
              "Estado",
              "Financiado",
              "Devuelto",
              "Resultado",
              "%",
            ]}
            testId="cycle-games"
          >
            {c.games.map((g) => (
              <tr key={g.id} data-testid="cycle-game-row">
                <Td>{g.gameNumber}</Td>
                <Td>{g.session.folio}</Td>
                <Td>{g.session.businessDate}</Td>
                <Td>{GAME_STATUS[g.status]}</Td>
                <Td>{formatMXN(g.financed)}</Td>
                <Td>{g.returned ? formatMXN(g.returned) : "—"}</Td>
                <Td>
                  <span data-testid="game-result">
                    {g.effectiveResult ? formatMXN(g.effectiveResult) : "—"}
                  </span>
                  {Number(g.adjustments) !== 0 ? (
                    <span className="text-muted-foreground block text-xs">
                      bruto {formatMXN(g.grossResult)} · ajustes{" "}
                      {formatMXN(g.adjustments)}
                    </span>
                  ) : null}
                </Td>
                <Td>{g.playerPercent}%</Td>
              </tr>
            ))}
          </Table>
          {canApprove && c.status !== "CLOSED"
            ? c.games
                .filter((g) => g.status === "CONFIRMED")
                .map((g) => (
                  <Panel
                    key={g.id}
                    title={`Ajuste auditado de la jugada ${g.gameNumber}`}
                    testId={`adjust-${g.gameNumber}`}
                  >
                    <ActionForm
                      url={`${BANKING_API}/games/${g.id}/adjust`}
                      testId={`adjust-form-${g.gameNumber}`}
                      submitLabel="Registrar ajuste"
                      variant="outline"
                      success="Ajuste registrado (el corte en revisión se invalida)"
                      fields={[
                        {
                          name: "amount",
                          label: "Ajuste (usa - para restar)",
                          type: "text",
                          required: true,
                        },
                        {
                          name: "reason",
                          label: "Motivo",
                          type: "textarea",
                          required: true,
                        },
                      ]}
                    />
                  </Panel>
                ))
            : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tramos de porcentaje</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={["Desde la jugada", "% jugador", "% casa", "Registrado"]}
            testId="cycle-segments"
          >
            {c.segments.map((s) => (
              <tr key={s.id}>
                <Td>{s.fromGameNumber}</Td>
                <Td>{s.playerPercent}%</Td>
                <Td>{s.housePercent}%</Td>
                <Td>{formatDateTime(s.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        </CardContent>
      </Card>

      {p ? (
        <Card data-testid="cycle-provisional">
          <CardHeader>
            <CardTitle className="text-base">
              {c.status === "CLOSED" ? "Cálculo actual" : "Cálculo provisional"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KeyValue label="Resultado bruto" testId="prov-gross">
                {formatMXN(p.grossTotal)}
              </KeyValue>
              <KeyValue label="Pérdida anterior">
                {c.previousCarriedLoss === null
                  ? "Corte anterior sin aprobar"
                  : formatMXN(c.previousCarriedLoss)}
              </KeyValue>
              <KeyValue label="Compensado con ganancias">
                {formatMXN(p.coveredByGains)}
              </KeyValue>
              <KeyValue label="Reserva aplicable">
                {formatMXN(p.reserveConsumed)}
              </KeyValue>
              <KeyValue label="Pérdida a arrastrar">
                {formatMXN(p.carriedLossOut)}
              </KeyValue>
              <KeyValue label="Participación jugador" testId="prov-player">
                {formatMXN(p.playerShare)}
              </KeyValue>
              <KeyValue label="Participación casa">
                {formatMXN(p.houseShare)}
              </KeyValue>
              <KeyValue label="Anticipos pagados">
                {formatMXN(p.advancesPaid)}
              </KeyValue>
              <KeyValue label="Recuperación de excedentes">
                {formatMXN(p.recoveryApplied)}
              </KeyValue>
              <KeyValue label="Saldo disponible" testId="prov-balance">
                {formatMXN(p.balance)}
              </KeyValue>
              <KeyValue label="Anticipo excedido" testId="prov-excess">
                {formatMXN(p.excessAdvance)}
              </KeyValue>
            </dl>
            {p.allocationRequired ? (
              <p
                className="text-xs text-amber-700 dark:text-amber-400"
                data-testid="prov-allocation"
              >
                Reparto PROVISIONAL: hay pérdidas entre tramos con porcentajes
                distintos; la distribución definitiva la decide un socio en el
                corte.
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Límite de anticipos: garantizado{" "}
              {formatMXN(c.advanceLimit.guaranteedShare)} · comprometido{" "}
              {formatMXN(c.advanceLimit.committed)} · disponible{" "}
              {formatMXN(c.advanceLimit.available)}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {ready && canOperate && p ? (
        <Card data-testid="prepare-closing-card">
          <CardHeader>
            <CardTitle className="text-base">
              {review
                ? "Preparar una nueva versión del corte"
                : "Preparar corte"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PrepareClosingForm
              cycleId={c.id}
              tranches={p.tranches.map((t) => ({
                key: t.key,
                playerPercent: t.playerPercent,
                gains: t.gains,
              }))}
              allocationRequired={p.allocationRequired}
              canAllocate={canApprove}
              balance={p.balance}
            />
          </CardContent>
        </Card>
      ) : null}

      {c.closings.map((x) => {
        const snap = x.snapshot as {
          computation?: {
            tranches?: {
              playerPercent: string
              absorbed: string
              playerShare: string
            }[]
          }
        }
        return (
          <Card key={x.id} data-testid="closing-card">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                Corte v{x.version}
                <StatusBadge
                  value={x.status}
                  label={CLOSING_STATUS[x.status]}
                  testId="closing-status"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KeyValue label="Participación jugador" testId="closing-player">
                  {formatMXN(x.playerShare)}
                </KeyValue>
                <KeyValue label="Participación casa">
                  {formatMXN(x.houseShare)}
                </KeyValue>
                <KeyValue label="Anticipos pagados">
                  {formatMXN(x.advancesPaid)}
                </KeyValue>
                <KeyValue label="Reserva consumida">
                  {formatMXN(x.reserveConsumed)}
                </KeyValue>
                <KeyValue label="A reserva" testId="closing-reserve-amount">
                  {formatMXN(x.reserveAmount)}
                </KeyValue>
                <KeyValue label="Para pago" testId="closing-pay-amount">
                  {formatMXN(x.payAmount)}
                </KeyValue>
                <KeyValue label="Pérdida arrastrada">
                  {formatMXN(x.carriedLossOut)}
                </KeyValue>
                <KeyValue label="Excedente">
                  {formatMXN(x.excessAdvance)}
                </KeyValue>
              </dl>
              {snap.computation?.tranches &&
              snap.computation.tranches.length > 1 ? (
                <ul className="text-muted-foreground text-xs">
                  {snap.computation.tranches.map((t, i) => (
                    <li key={i}>
                      Tramo {t.playerPercent}%: absorbe {formatMXN(t.absorbed)}{" "}
                      · jugador {formatMXN(t.playerShare)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted-foreground text-xs">
                Preparó {x.preparedBy.name} · {formatDateTime(x.preparedAt)}
                {x.decidedBy ? ` · decidió ${x.decidedBy.name}` : ""}
                {x.decisionNotes ? ` · ${x.decisionNotes}` : ""}
              </p>
              <p className="text-muted-foreground font-mono text-[10px] break-all">
                Huella {x.snapshotHash}
              </p>
              {x.status === "UNDER_REVIEW" && canApprove ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <ActionForm
                    url={`${BANKING_API}/cycles/${c.id}/approve-closing`}
                    testId="approve-closing-form"
                    submitLabel="Aprobar digitalmente"
                    success="Corte aprobado"
                    extra={{ closingId: x.id, snapshotHash: x.snapshotHash }}
                    fields={[
                      {
                        name: "notes",
                        label: "Observaciones",
                        type: "text",
                        optional: true,
                      },
                    ]}
                  />
                  <ActionForm
                    url={`${BANKING_API}/cycles/${c.id}/reject-closing`}
                    testId="reject-closing-form"
                    submitLabel="Rechazar"
                    variant="outline"
                    success="Corte rechazado"
                    extra={{ closingId: x.id }}
                    fields={[
                      {
                        name: "notes",
                        label: "Motivo del rechazo",
                        type: "textarea",
                        required: true,
                      },
                    ]}
                  />
                </div>
              ) : null}
              {x.status === "UNDER_REVIEW" && !canApprove ? (
                <p className="text-xs" data-testid="approval-required">
                  Requiere la aprobación digital de un PARTNER o SUPERADMIN.
                </p>
              ) : null}
              {x.payable ? (
                <div
                  className="space-y-2 rounded-lg border p-3"
                  data-testid="closing-payable"
                >
                  <p>
                    Obligación por pagar {formatMXN(x.payable.original)} ·
                    pagado{" "}
                    <strong data-testid="closing-paid">
                      {formatMXN(x.payable.paid)}
                    </strong>{" "}
                    · pendiente{" "}
                    <strong data-testid="closing-payable-pending">
                      {formatMXN(x.payable.pending)}
                    </strong>
                  </p>
                  {x.payable.payouts
                    .filter((po) => po.status === "PENDING")
                    .map((po) => (
                      <Panel
                        key={po.id}
                        title={`Transferencia ${po.folio} en trámite`}
                        testId={`closing-pending-${po.id}`}
                      >
                        <ResolvePayoutForm payoutId={po.id} />
                      </Panel>
                    ))}
                  {canOperate && Number(x.payable.available) > 0 ? (
                    <Panel
                      title="Registrar pago (parcial o total)"
                      testId="closing-pay-panel"
                    >
                      <DisburseForm
                        url={`${BANKING_API}/payables/${x.payable.id}/payouts`}
                        testId="closing-disburse"
                        sessionCashAllowed
                      />
                    </Panel>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
    </>
  )
}
