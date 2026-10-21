import { notFound } from "next/navigation"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { NotFoundError } from "@/lib/errors"
import { formatDateTime } from "@/lib/format"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import { getBackup } from "@/modules/backups/backup.service"

import { BackLink } from "../../../sesiones/back-link"

export const metadata = { title: "Respaldo — Poker Manager" }

type Manifest = {
  tables?: Record<string, { rows: number; sha256: string }>
  evidence?: {
    count: number
    active: number
    problems: { fileId: string; problem: string }[]
  }
  components?: string[]
}

export default async function BackupPage({
  params,
}: PageProps<"/dashboard/administracion/respaldos/[id]">) {
  await requirePagePermission(
    PERMISSIONS.BACKUPS_READ,
    `${ADMIN_BASE}/respaldos`
  )
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound()
  const b = await getBackup(id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound()
    throw e
  })
  const m = (b.manifest ?? {}) as Manifest
  return (
    <>
      <BackLink href={`${ADMIN_BASE}/respaldos`} label="Respaldos" />
      <PageHeader
        title="Respaldo"
        description={`${b.trigger} · ${formatDateTime(b.startedAt)}`}
        actions={<StatusBadge value={b.status} />}
      />
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
            <KeyValue label="Punto de recuperación">
              {b.recoveryPoint ? formatDateTime(b.recoveryPoint) : "—"}
            </KeyValue>
            <KeyValue label="Versión de esquema">
              {b.schemaVersion ?? "—"} ({b.migrationsCount ?? 0} migraciones)
            </KeyValue>
            <KeyValue label="Verificación">
              <StatusBadge value={b.verificationStatus} />{" "}
              {b.verifiedAt ? formatDateTime(b.verifiedAt) : ""}
            </KeyValue>
            <KeyValue label="Componentes">
              {m.components?.join(" · ") ?? "—"}
            </KeyValue>
            <KeyValue label="Cifrado">
              {b.encryption ?? "—"} · huella de clave {b.keyFingerprint ?? "—"}
            </KeyValue>
            <KeyValue label="Ubicación lógica">
              <span className="font-mono text-xs">
                {b.destination}:{b.location ?? "—"}
              </span>
            </KeyValue>
            <KeyValue label="Checksum SHA-256">
              <span className="font-mono text-xs break-all">
                {b.artifactSha256 ?? "—"}
              </span>
            </KeyValue>
            <KeyValue label="Evidencias">
              {m.evidence
                ? `${m.evidence.count} archivo(s), ${m.evidence.problems.length} con problemas`
                : "—"}
            </KeyValue>
            {b.error || b.verificationError ? (
              <KeyValue label="Error">
                {b.error ?? b.verificationError}
              </KeyValue>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Manifiesto por tabla</CardTitle>
        </CardHeader>
        <CardContent>
          <Table head={["Tabla", "Filas", "SHA-256"]}>
            {Object.entries(m.tables ?? {}).map(([t, v]) => (
              <tr key={t}>
                <Td className="font-mono text-xs">{t}</Td>
                <Td>{v.rows}</Td>
                <Td className="font-mono text-xs">{v.sha256.slice(0, 16)}…</Td>
              </tr>
            ))}
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
