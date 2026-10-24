import { Card, CardContent } from "@/components/ui/card"
import { can, PERMISSIONS, requirePagePermission } from "@/config/permissions"
import {
  ADMIN_BASE,
  PageHeader,
  StatusBadge,
  Table,
  Td,
} from "@/modules/admin/components/admin-ui"
import {
  StaffActiveToggle,
  StaffCreateForm,
} from "@/modules/staff-tips/components/staff-actions"
import { listPositions, listStaff } from "@/modules/staff-tips/staff.service"

export const metadata = { title: "Staff — Poker Manager" }

/** Catálogo del staff (Módulo 18): dealers, meseros y otros puestos. */
export default async function StaffPage() {
  const user = await requirePagePermission(
    PERMISSIONS.STAFF_READ,
    `${ADMIN_BASE}/staff`
  )
  const [staff, positions] = await Promise.all([listStaff(), listPositions()])
  const manage = can(user, PERMISSIONS.STAFF_MANAGE)
  return (
    <>
      <PageHeader
        title="Staff"
        description="Personal que recibe propinas (dealers, meseros y otros). Sin usuario ni acceso al sistema; nunca se borran, se desactivan. Las propinas se capturan en cada sesión."
      />
      {manage ? (
        <Card>
          <CardContent className="pt-4">
            <StaffCreateForm positions={positions.filter((p) => p.isActive)} />
          </CardContent>
        </Card>
      ) : null}
      <Table
        head={["Nombre", "Puesto", "Estado", "Sesiones", ""]}
        testId="staff-table"
      >
        {staff.map((s) => (
          <tr key={s.id} data-testid="staff-row">
            <Td>{s.name}</Td>
            <Td>{s.position.name}</Td>
            <Td>
              <StatusBadge
                value={s.isActive ? "ACTIVE" : "INACTIVE"}
                label={s.isActive ? "Activo" : "Inactivo"}
              />
            </Td>
            <Td>{s.sessions}</Td>
            <Td>
              {manage ? (
                <StaffActiveToggle id={s.id} isActive={s.isActive} />
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  )
}
