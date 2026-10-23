import Link from "next/link"
import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  ADMIN_BASE,
  correctionTypeFor,
  entityHref,
  KeyValue,
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/modules/admin/components/admin-ui"
import {
  auditFiltersToQuery,
  parseAuditFilters,
} from "@/modules/audit/audit.filters"
import { getAuditEvent } from "@/modules/audit/audit-query.service"
import { formatMXN } from "@/modules/cash/components/format"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Evento de auditoría — Poker Manager" }

export default async function AuditEventPage({
  params,
  searchParams,
}: PageProps<"/dashboard/administracion/auditoria/[id]">) {
  const user = await requirePagePermission(
    PERMISSIONS.AUDIT_READ,
    `${ADMIN_BASE}/auditoria`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const parsed = parseAuditFilters(await searchParams)
  const e = await getAuditEvent(id, {
    canSecurity: can(user, PERMISSIONS.AUDIT_SECURITY_READ),
    canInfrastructure: can(user, PERMISSIONS.BACKUPS_READ),
    canBanking: can(user, PERMISSIONS.BANKING_READ),
  }).catch((err: unknown) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })
  const href = entityHref(e.entityType, e.entityId)
  const correctionType = correctionTypeFor(e.entityType)
  return (
    <>
      <BackLink
        href={`${ADMIN_BASE}/auditoria${parsed.ok ? auditFiltersToQuery(parsed.filters) : ""}`}
        label="Auditoría"
      />
      <PageHeader
        title={e.action}
        description={`${e.moduleLabel} · ${formatDateTime(e.occurredAt)}`}
        actions={
          <>
            {href ? (
              <LinkButton href={href} testId="audit-entity-link">
                Ver {e.entityType}
              </LinkButton>
            ) : null}
            {correctionType &&
            e.entityId &&
            can(user, PERMISSIONS.CORRECTIONS_REQUEST) ? (
              <LinkButton
                href={`${ADMIN_BASE}/correcciones/nueva?type=${correctionType}&targetId=${e.entityId}`}
                testId="audit-request-correction"
              >
                Solicitar corrección
              </LinkButton>
            ) : null}
          </>
        }
      />
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
            <KeyValue label="Resultado">
              <StatusBadge value={e.result} />
            </KeyValue>
            <KeyValue label="Usuario">{e.actor?.name ?? "Sistema"}</KeyValue>
            <KeyValue label="Rol al momento">
              {e.actorRole ?? "No registrado (evento previo al Módulo 15)"}
            </KeyValue>
            <KeyValue label="Entidad" testId="audit-entity">
              {e.entityType} {e.entityId ?? ""}
            </KeyValue>
            <KeyValue label="Sesión">
              {e.session ? (e.session.folio ?? e.session.id) : "—"}
            </KeyValue>
            <KeyValue label="Mesa">{e.table ?? "—"}</KeyValue>
            <KeyValue label="Jugador">
              {e.player ? (e.player.name ?? e.player.id) : "—"}
            </KeyValue>
            <KeyValue label="Importe">
              {e.amount ? formatMXN(e.amount) : "—"}
            </KeyValue>
            <KeyValue label="Request / correlación">
              <span className="font-mono text-xs">{e.requestId ?? "—"}</span>
            </KeyValue>
            <KeyValue label="Clave de idempotencia">
              <span className="font-mono text-xs">
                {e.idempotencyKey ?? "—"}
              </span>
            </KeyValue>
            <KeyValue label="Motivo">{e.reason ?? "—"}</KeyValue>
            <KeyValue label="Evidencia">{e.evidenceRef ?? "—"}</KeyValue>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resumen estructurado</CardTitle>
          <p className="text-muted-foreground text-xs">
            Sin contraseñas, tokens, imágenes de firmas ni secretos (se filtran
            al registrar).
          </p>
        </CardHeader>
        <CardContent>
          <pre
            className="bg-muted overflow-x-auto rounded-md p-3 text-xs"
            data-testid="audit-metadata"
          >
            {JSON.stringify(e.metadata ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
      {e.related.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Eventos relacionados (misma operación)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {e.related.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`${ADMIN_BASE}/auditoria/${r.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {formatDateTime(r.occurredAt)} · {r.action}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Este registro es inmutable: no existe ninguna acción para editarlo ni
        borrarlo.
      </p>
    </>
  )
}
