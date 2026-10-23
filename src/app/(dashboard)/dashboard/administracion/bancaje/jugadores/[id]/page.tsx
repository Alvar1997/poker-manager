import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import {
  KeyValue,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import {
  getBankedPlayer,
  getCycle,
  listAuthorizers,
} from "@/modules/banking/banking-query.service"
import {
  ActionForm,
  DisburseForm,
  Panel,
  ResolvePayoutForm,
} from "@/modules/banking/components/banking-actions"
import {
  BANKING_API,
  ADVANCE_STATUS,
  BANKING_BASE,
  CHANNEL,
  CYCLE_STATUS,
  GAME_STATUS,
  REG_KIND,
  REG_STATUS,
  REQUEST_STATUS,
  RESERVE_KIND,
  WITHDRAWAL_STATUS,
} from "@/modules/banking/components/labels"
import { formatMXN } from "@/modules/cash/components/format"
import { formatDateTime } from "@/lib/format"

export const metadata = { title: "Jugador bancado — Poker Manager" }
export const dynamic = "force-dynamic"

type PayableList = {
  id: string
  pending: string
  payouts: {
    id: string
    status: string
    method: string
    amount: string
    folio: string
  }[]
}[]

function PendingTransfers({ payables }: { payables: PayableList }) {
  const pending = payables.flatMap((p) =>
    p.payouts.filter((x) => x.status === "PENDING")
  )
  if (pending.length === 0) return null
  return (
    <div className="space-y-2">
      {pending.map((x) => (
        <Panel
          key={x.id}
          title={`Transferencia ${x.folio} en trámite · ${formatMXN(x.amount)}`}
          testId={`pending-${x.id}`}
        >
          <ResolvePayoutForm payoutId={x.id} />
        </Panel>
      ))}
    </div>
  )
}

function UnpaidPayables({
  payables,
  sessionCash,
}: {
  payables: PayableList
  sessionCash: boolean
}) {
  const unpaid = payables.filter(
    (p) =>
      Number(p.pending) > 0 && !p.payouts.some((x) => x.status === "PENDING")
  )
  return (
    <>
      {unpaid.map((p) => (
        <Panel
          key={p.id}
          title={`Obligación sin pagar · ${formatMXN(p.pending)}`}
          testId={`unpaid-${p.id}`}
        >
          <DisburseForm
            url={`${BANKING_API}/payables/${p.id}/payouts`}
            testId={`retry-${p.id}`}
            sessionCashAllowed={sessionCash}
          />
        </Panel>
      ))}
    </>
  )
}

export default async function BankedPlayerPage({
  params,
}: PageProps<"/dashboard/administracion/bancaje/jugadores/[id]">) {
  const { id } = await params
  const user = await requirePagePermission(
    PERMISSIONS.BANKING_READ,
    `${BANKING_BASE}/jugadores/${id}`
  )
  const canApprove = can(user, PERMISSIONS.BANKING_APPROVE)
  const canOperate = can(user, PERMISSIONS.BANKING_OPERATE)
  let v
  try {
    v = await getBankedPlayer(id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const openCycleRow = v.cycles.find((c) => c.status !== "CLOSED") ?? null
  const [cycle, authorizers] = await Promise.all([
    openCycleRow ? getCycle(openCycleRow.id) : Promise.resolve(null),
    listAuthorizers(),
  ])
  const winning = (cycle?.games ?? []).filter(
    (g) => g.status === "CONFIRMED" && Number(g.effectiveResult) > 0
  )
  const sessionCash = Boolean(v.openSession)
  const pendingChange = v.changeRequests.find((r) => r.status === "PENDING")
  return (
    <>
      <PageHeader
        title={v.player.name}
        description="Expediente privado de bancaje. La mesa nunca muestra esta información."
      />
      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <KeyValue label="Acuerdo" testId="player-agreement">
              {v.agreement
                ? `${v.agreement.playerPercent}% jugador / ${v.agreement.housePercent}% casa`
                : "Sin acuerdo vigente"}
            </KeyValue>
            <KeyValue label="Ciclo actual" testId="player-cycle">
              {openCycleRow
                ? `#${openCycleRow.number} · ${openCycleRow.confirmed}/4 · ${CYCLE_STATUS[openCycleRow.status]}`
                : "—"}
            </KeyValue>
            <KeyValue label="Reserva (contable)" testId="player-reserve">
              {formatMXN(v.reserve.balance)}
            </KeyValue>
            <KeyValue
              label="Pérdida por recuperar"
              testId="player-pending-loss"
            >
              {formatMXN(v.pendingLoss)}
            </KeyValue>
          </dl>
        </CardContent>
      </Card>

      {v.live && canOperate ? (
        <Card data-testid="live-panel">
          <CardHeader>
            <CardTitle className="text-base">
              Sesión {v.live.sessionFolio} · {v.live.tableName}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {v.live.game ? (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <KeyValue label="Jugada">
                  {GAME_STATUS[v.live.game.status]}
                </KeyValue>
                <KeyValue
                  label="Financiado en la sesión"
                  testId="live-financed"
                >
                  {formatMXN(v.live.game.financed)} ({v.live.game.purchases})
                </KeyValue>
              </dl>
            ) : null}
            {v.agreement &&
            v.live.ownPurchases === 0 &&
            (!v.live.game || v.live.game.status === "IN_PROGRESS") ? (
              <Panel
                title="Entregar fichas financiadas (compra o recompra)"
                testId="financed-panel"
                open
              >
                <ActionForm
                  url={`${BANKING_API}/financed-purchases`}
                  testId="financed-form"
                  submitLabel="Registrar entrega financiada"
                  success="Entrega registrada. La mesa la muestra como cualquier compra."
                  extra={{ participationId: v.live.participationId }}
                  fields={[
                    {
                      name: "nominalAmount",
                      label: "Importe nominal entregado",
                      type: "money",
                      required: true,
                    },
                    {
                      name: "physicalDeliveryConfirmed",
                      label: "Entregué físicamente las fichas al jugador",
                      type: "checkbox",
                    },
                  ]}
                />
              </Panel>
            ) : v.live.ownPurchases > 0 ? (
              <p className="text-muted-foreground text-sm">
                El jugador compró con dinero propio en esta sesión: no se
                mezclan fichas financiadas.
              </p>
            ) : null}
            {v.live.game?.status === "IN_PROGRESS" ? (
              <>
                <Panel
                  title="Conciliar devolución física y confirmar la jugada"
                  testId="reconcile-panel"
                >
                  <ActionForm
                    url={`${BANKING_API}/games/${v.live.game.id}/reconcile`}
                    testId="reconcile-form"
                    submitLabel="Confirmar jugada"
                    success="Jugada conciliada. El jugador sale de la mesa sin pago automático."
                    extra={{ expectedVersion: v.live.game.version }}
                    fields={[
                      {
                        name: "returnedNominalAmount",
                        label: "Valor nominal REALMENTE devuelto",
                        type: "money",
                        required: true,
                        hint: "Si terminó sin fichas captura 0 y confírmalo abajo.",
                      },
                      {
                        name: "zeroReturnConfirmed",
                        label:
                          "Confirmo que el jugador terminó con CERO fichas",
                        type: "checkbox",
                      },
                      {
                        name: "physicalReturnVerified",
                        label:
                          "Verifiqué físicamente la devolución (o el retorno cero)",
                        type: "checkbox",
                      },
                    ]}
                  />
                </Panel>
                <Panel
                  title="Reportar discrepancia física"
                  testId="discrepancy-panel"
                >
                  <ActionForm
                    url={`${BANKING_API}/games/${v.live.game.id}/discrepancy`}
                    testId="discrepancy-form"
                    submitLabel="Bloquear y reportar"
                    variant="destructive"
                    success="Discrepancia registrada"
                    fields={[
                      {
                        name: "description",
                        label: "¿Qué no coincide?",
                        type: "textarea",
                        required: true,
                      },
                    ]}
                  />
                </Panel>
              </>
            ) : null}
            {v.live.game?.status === "PENDING_RECONCILIATION" && canApprove ? (
              <Panel
                title="Aclarar discrepancia (socio)"
                testId="resolve-discrepancy-panel"
                open
              >
                <ActionForm
                  url={`${BANKING_API}/games/${v.live.game.id}/resolve-discrepancy`}
                  testId="resolve-discrepancy-form"
                  submitLabel="Aclarar"
                  success="Discrepancia aclarada"
                  fields={[
                    {
                      name: "notes",
                      label: "Resolución",
                      type: "textarea",
                      required: true,
                    },
                  ]}
                />
              </Panel>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ciclos</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={["Ciclo", "Estado", "Jugadas", "Resultado neto"]}
            testId="player-cycles"
          >
            {v.cycles.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link
                    href={`${BANKING_BASE}/ciclos/${c.id}`}
                    className="underline"
                    data-testid="cycle-link"
                  >
                    #{c.number}
                  </Link>
                </Td>
                <Td>
                  <StatusBadge
                    value={c.status}
                    label={CYCLE_STATUS[c.status]}
                  />
                </Td>
                <Td>{c.confirmed}/4</Td>
                <Td>{formatMXN(c.net)}</Td>
              </tr>
            ))}
          </Table>
        </CardContent>
      </Card>

      <Card data-testid="advances-card">
        <CardHeader>
          <CardTitle className="text-base">Anticipos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {cycle ? (
            <p className="text-sm" data-testid="advance-available">
              Disponible garantizado:{" "}
              <strong>{formatMXN(cycle.advanceLimit.available)}</strong>
              {cycle.advanceLimit.blockedReason ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {cycle.advanceLimit.blockedReason}
                </span>
              ) : null}
            </p>
          ) : null}
          {canOperate && v.agreement && winning.length > 0 ? (
            <Panel
              title="Registrar anticipo autorizado por un socio"
              testId="advance-panel"
            >
              <ActionForm
                url={`${BANKING_API}/advances`}
                testId="advance-form"
                submitLabel="Registrar anticipo"
                success="Anticipo registrado (aún no se paga)"
                extra={{ playerId: v.player.id }}
                fields={[
                  {
                    name: "enablingGameId",
                    label: "Jugada ganadora que lo habilita",
                    type: "select",
                    required: true,
                    options: winning.map((g) => ({
                      value: g.id,
                      label: `Jugada ${g.gameNumber} · ${g.session.folio} · ${formatMXN(g.effectiveResult)}`,
                    })),
                  },
                  {
                    name: "requestedAmount",
                    label: "Importe solicitado",
                    type: "money",
                    required: true,
                  },
                  {
                    name: "authorizedAmount",
                    label: "Importe autorizado por el socio",
                    type: "money",
                    required: true,
                  },
                  {
                    name: "authorizerId",
                    label: "Socio que autorizó",
                    type: "select",
                    required: true,
                    options: authorizers.map((a) => ({
                      value: a.id,
                      label: `${a.name} (${a.role})`,
                    })),
                  },
                  {
                    name: "channel",
                    label: "¿Cómo lo autorizó?",
                    type: "select",
                    required: true,
                    options: [
                      { value: "VERBAL", label: "Verbalmente" },
                      { value: "MESSAGE", label: "Por mensaje" },
                    ],
                  },
                  {
                    name: "notes",
                    label: "Notas (opcional)",
                    type: "text",
                    optional: true,
                  },
                ]}
              />
            </Panel>
          ) : null}
          {v.advances.map((a) => (
            <div
              key={a.id}
              className="space-y-2 rounded-lg border p-3 text-sm"
              data-testid="advance-row"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Ciclo #{a.cycleNumber} · autorizado {formatMXN(a.authorized)}{" "}
                  · pagado{" "}
                  <strong data-testid="advance-paid">
                    {formatMXN(a.paid)}
                  </strong>
                  {Number(a.inTransit) > 0
                    ? ` · en trámite ${formatMXN(a.inTransit)}`
                    : ""}
                </span>
                <StatusBadge
                  value={a.status}
                  label={ADVANCE_STATUS[a.status]}
                  testId="advance-status"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                {a.authorizerName} · {CHANNEL[a.channel]} · registrado por{" "}
                {a.recordedBy.name} · {formatDateTime(a.recordedAt)}
              </p>
              {canOperate &&
              (a.status === "AUTHORIZED" || a.status === "PARTIALLY_PAID") ? (
                <>
                  <PendingTransfers payables={a.payables} />
                  <UnpaidPayables
                    payables={a.payables}
                    sessionCash={sessionCash}
                  />
                  <Panel
                    title="Entregar dinero del anticipo"
                    testId={`disburse-${a.id}`}
                  >
                    <DisburseForm
                      url={`${BANKING_API}/advances/${a.id}/disburse`}
                      testId={`advance-disburse-${a.id}`}
                      sessionCashAllowed={sessionCash}
                    />
                  </Panel>
                  <Panel
                    title="Cerrar remanente no pagado"
                    testId={`close-advance-${a.id}`}
                  >
                    <ActionForm
                      url={`${BANKING_API}/advances/${a.id}/close`}
                      testId={`close-advance-form-${a.id}`}
                      submitLabel="Cerrar anticipo"
                      variant="outline"
                      success="Anticipo cerrado"
                      fields={[
                        {
                          name: "reason",
                          label: "Motivo",
                          type: "textarea",
                          required: true,
                        },
                      ]}
                    />
                  </Panel>
                </>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card data-testid="reserve-card">
        <CardHeader>
          <CardTitle className="text-base">Reserva positiva</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <dl className="grid grid-cols-3 gap-3">
            <KeyValue label="Saldo">{formatMXN(v.reserve.balance)}</KeyValue>
            <KeyValue label="Retirable" testId="reserve-withdrawable">
              {formatMXN(v.reserve.withdrawable)}
            </KeyValue>
            <KeyValue label="Déficit de ciclos abiertos">
              {formatMXN(v.reserve.openCyclesDeficit)}
            </KeyValue>
          </dl>
          {canOperate ? (
            <Panel
              title="Solicitar retiro de reserva"
              testId="withdrawal-panel"
            >
              <ActionForm
                url={`${BANKING_API}/reserves/withdrawals`}
                testId="withdrawal-form"
                submitLabel="Solicitar retiro"
                success="Retiro solicitado: requiere aprobación digital"
                extra={{ playerId: v.player.id }}
                fields={[
                  {
                    name: "amount",
                    label: "Importe",
                    type: "money",
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
          ) : null}
          <Table
            head={["Movimiento", "Importe", "Fecha"]}
            testId="reserve-movements"
          >
            {v.reserve.movements.map((m) => (
              <tr key={m.id}>
                <Td>{RESERVE_KIND[m.kind]}</Td>
                <Td>{formatMXN(m.amount)}</Td>
                <Td>{formatDateTime(m.createdAt)}</Td>
              </tr>
            ))}
          </Table>
          {v.withdrawals.map((w) => (
            <div
              key={w.id}
              className="space-y-2 rounded-lg border p-3"
              data-testid="withdrawal-row"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Retiro solicitado {formatMXN(w.requested)}
                  {w.approved ? ` · aprobado ${formatMXN(w.approved)}` : ""} ·
                  pagado{" "}
                  <strong data-testid="withdrawal-paid">
                    {formatMXN(w.paid)}
                  </strong>
                </span>
                <StatusBadge
                  value={w.status}
                  label={WITHDRAWAL_STATUS[w.status]}
                  testId="withdrawal-status"
                />
              </div>
              {w.status === "REQUESTED" && canApprove ? (
                <Panel
                  title="Aprobación digital"
                  testId={`withdrawal-decision-${w.id}`}
                  open
                >
                  <ActionForm
                    url={`${BANKING_API}/reserves/withdrawals/${w.id}/decision`}
                    testId={`withdrawal-decision-form-${w.id}`}
                    submitLabel="Registrar decisión"
                    success="Decisión registrada"
                    fields={[
                      {
                        name: "decision",
                        label: "Decisión",
                        type: "select",
                        required: true,
                        options: [
                          { value: "APPROVE", label: "Aprobar" },
                          { value: "REJECT", label: "Rechazar" },
                        ],
                      },
                      {
                        name: "approvedAmount",
                        label: "Importe aprobado (vacío = lo solicitado)",
                        type: "money",
                        optional: true,
                      },
                      {
                        name: "notes",
                        label: "Notas",
                        type: "text",
                        optional: true,
                      },
                    ]}
                  />
                </Panel>
              ) : null}
              {w.status === "REQUESTED" && canOperate ? (
                <Panel
                  title="Cancelar solicitud"
                  testId={`withdrawal-cancel-${w.id}`}
                >
                  <ActionForm
                    url={`${BANKING_API}/reserves/withdrawals/${w.id}/cancel`}
                    testId={`withdrawal-cancel-form-${w.id}`}
                    submitLabel="Cancelar"
                    variant="outline"
                    success="Solicitud cancelada"
                    fields={[
                      {
                        name: "reason",
                        label: "Motivo",
                        type: "textarea",
                        required: true,
                      },
                    ]}
                  />
                </Panel>
              ) : null}
              {(w.status === "APPROVED" || w.status === "PARTIALLY_PAID") &&
              canOperate ? (
                <>
                  <PendingTransfers payables={w.payables} />
                  <UnpaidPayables
                    payables={w.payables}
                    sessionCash={sessionCash}
                  />
                  <Panel title="Pagar retiro" testId={`withdrawal-pay-${w.id}`}>
                    <DisburseForm
                      url={`${BANKING_API}/reserves/withdrawals/${w.id}/disburse`}
                      testId={`withdrawal-disburse-${w.id}`}
                      sessionCashAllowed={sessionCash}
                    />
                  </Panel>
                  <Panel
                    title="Cerrar remanente (regresa a la reserva)"
                    testId={`withdrawal-close-${w.id}`}
                  >
                    <ActionForm
                      url={`${BANKING_API}/reserves/withdrawals/${w.id}/close`}
                      testId={`withdrawal-close-form-${w.id}`}
                      submitLabel="Cerrar retiro"
                      variant="outline"
                      success="Retiro cerrado"
                      fields={[
                        {
                          name: "reason",
                          label: "Motivo",
                          type: "textarea",
                          required: true,
                        },
                      ]}
                    />
                  </Panel>
                </>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {v.agreement ? (
        <Card data-testid="percentage-card">
          <CardHeader>
            <CardTitle className="text-base">Cambio de porcentaje</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {canOperate && !pendingChange ? (
              <Panel
                title="Solicitar cambio (requiere aprobación digital)"
                testId="change-panel"
              >
                <ActionForm
                  url={`${BANKING_API}/agreements/${v.agreement.id}/change-request`}
                  testId="change-form"
                  submitLabel="Solicitar cambio"
                  success="Cambio solicitado"
                  fields={[
                    {
                      name: "playerPercent",
                      label: "Nuevo porcentaje del jugador",
                      type: "percent",
                      required: true,
                    },
                    {
                      name: "mode",
                      label: "¿Desde cuándo aplica?",
                      type: "select",
                      required: true,
                      options: [
                        {
                          value: "FROM_NEXT_GAME",
                          label: "Desde la siguiente jugada",
                        },
                        {
                          value: "WHOLE_CYCLE",
                          label: "A todo el ciclo actual",
                        },
                      ],
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
            ) : null}
            {v.changeRequests.map((r) => (
              <div
                key={r.id}
                className="space-y-2 rounded-lg border p-3"
                data-testid="change-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {r.from}% → {r.to}% ·{" "}
                    {r.mode === "WHOLE_CYCLE"
                      ? "todo el ciclo"
                      : `desde la jugada ${r.startGameNumber}`}
                  </span>
                  <StatusBadge
                    value={r.status}
                    label={REQUEST_STATUS[r.status]}
                    testId="change-status"
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  {r.reason} · solicitó {r.requestedBy.name}
                  {r.decidedBy ? ` · decidió ${r.decidedBy.name}` : ""}
                </p>
                {r.status === "PENDING" && canApprove ? (
                  <ActionForm
                    url={`${BANKING_API}/change-requests/${r.id}/decision`}
                    testId={`change-decision-${r.id}`}
                    submitLabel="Registrar decisión"
                    success="Decisión registrada"
                    fields={[
                      {
                        name: "decision",
                        label: "Decisión digital",
                        type: "select",
                        required: true,
                        options: [
                          { value: "APPROVE", label: "Aprobar" },
                          { value: "REJECT", label: "Rechazar" },
                        ],
                      },
                      {
                        name: "notes",
                        label: "Notas (obligatorias para rechazar)",
                        type: "text",
                        optional: true,
                      },
                    ]}
                  />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {v.regularizations.length > 0 ? (
        <Card data-testid="regularizations-card">
          <CardHeader>
            <CardTitle className="text-base">Regularizaciones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {v.regularizations.map((r) => (
              <div
                key={r.id}
                className="space-y-2 rounded-lg border p-3"
                data-testid="regularization-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {REG_KIND[r.kind]} · {formatMXN(r.amount)}
                  </span>
                  <StatusBadge value={r.status} label={REG_STATUS[r.status]} />
                </div>
                <p className="text-muted-foreground text-xs">{r.description}</p>
                <p className="text-muted-foreground text-xs">
                  Recuperado {formatMXN(r.recovered)} · recibido{" "}
                  {formatMXN(r.received)}
                </p>
                {r.kind === "EXCESS_ADVANCE" &&
                r.status === "OPEN" &&
                canApprove ? (
                  <ActionForm
                    url={`${BANKING_API}/regularizations/${r.id}/resolve`}
                    testId={`regularization-form-${r.id}`}
                    submitLabel="Definir tratamiento"
                    success="Tratamiento registrado"
                    fields={[
                      {
                        name: "resolution",
                        label: "Tratamiento (caso por caso)",
                        type: "select",
                        required: true,
                        options: [
                          {
                            value: "RECOVER_FROM_FUTURE",
                            label: "Recuperar de participaciones futuras",
                          },
                          {
                            value: "APPLY_RESERVE",
                            label: "Aplicar reserva disponible",
                          },
                          {
                            value: "MONEY_RETURNED",
                            label: "Devolución real de dinero",
                          },
                          {
                            value: "DOCUMENTED_WRITE_OFF",
                            label: "Otra (documentada; la casa lo absorbe)",
                          },
                        ],
                      },
                      {
                        name: "notes",
                        label: "Justificación",
                        type: "textarea",
                        required: true,
                      },
                    ]}
                  />
                ) : null}
                {r.status === "AWAITING_RETURN" && canOperate ? (
                  <ActionForm
                    url={`${BANKING_API}/regularizations/${r.id}/receipts`}
                    testId={`regularization-receipt-${r.id}`}
                    submitLabel="Registrar dinero recibido"
                    success="Devolución registrada"
                    fields={[
                      {
                        name: "amount",
                        label: "Efectivo recibido",
                        type: "money",
                        required: true,
                      },
                      {
                        name: "cashReceived",
                        label: "Recibí físicamente el efectivo",
                        type: "checkbox",
                      },
                    ]}
                  />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {v.agreement && canApprove ? (
        <Panel title="Terminar acuerdo" testId="end-agreement-panel">
          <ActionForm
            url={`${BANKING_API}/agreements/${v.agreement.id}/end`}
            testId="end-agreement-form"
            submitLabel="Terminar acuerdo"
            variant="destructive"
            success="Acuerdo terminado"
            fields={[
              {
                name: "reason",
                label: "Motivo",
                type: "textarea",
                required: true,
              },
            ]}
          />
        </Panel>
      ) : null}
    </>
  )
}
