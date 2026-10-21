import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PERMISSIONS, requirePagePermission } from "@/config/permissions"
import { formatDateTime } from "@/lib/format"
import { getSecurityOverview } from "@/modules/admin/security.service"
import {
  ADMIN_BASE,
  KeyValue,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"

export const metadata = { title: "Seguridad y accesos — Poker Manager" }

export default async function SecurityPage() {
  await requirePagePermission(
    PERMISSIONS.AUDIT_SECURITY_READ,
    `${ADMIN_BASE}/seguridad`
  )
  const s = await getSecurityOverview()
  const c = (k: string) => s.counts[k] ?? 0
  return (
    <>
      <PageHeader
        title="Seguridad y monitoreo de accesos"
        description={`Últimos ${s.windowDays} días. Solo SUPERADMIN.`}
      />
      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <KeyValue label="Inicios fallidos">
              {c("AUTH_LOGIN_FAILED")}
            </KeyValue>
            <KeyValue label="Bloqueos por intentos">
              {c("AUTH_LOGIN_RATE_LIMITED")}
            </KeyValue>
            <KeyValue label="Accesos denegados">
              {c("AUTH_ACCESS_DENIED")}
            </KeyValue>
            <KeyValue label="Cambios de rol">{c("USER_ROLE_CHANGED")}</KeyValue>
            <KeyValue label="Desactivaciones">{c("USER_DEACTIVATED")}</KeyValue>
            <KeyValue label="Restablecimientos">
              {c("USER_PASSWORD_RESET")}
            </KeyValue>
            <KeyValue label="Con contraseña temporal">
              {s.mustChangePassword}
            </KeyValue>
            <KeyValue label="Incidencias de seguridad abiertas">
              {s.openSecurityIncidents}
            </KeyValue>
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            Usuarios:{" "}
            {s.users
              .map(
                (u) => `${u.role}${u.active ? "" : " (inactivos)"}: ${u.count}`
              )
              .join(" · ")}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eventos recientes</CardTitle>
        </CardHeader>
        <CardContent>
          <Table
            head={["Fecha", "Evento", "Resultado", "Usuario", "Recurso"]}
            testId="security-events"
          >
            {s.recent.map((r) => (
              <tr key={r.id}>
                <Td>{formatDateTime(r.at)}</Td>
                <Td className="font-mono text-xs">{r.action}</Td>
                <Td>
                  <StatusBadge value={r.result} />
                </Td>
                <Td>{r.actor ?? "—"}</Td>
                <Td className="text-xs">{r.resource ?? r.entityId ?? "—"}</Td>
              </tr>
            ))}
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Controles vigentes</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {s.controls.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  )
}
