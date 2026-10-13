import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentUser } from "@/config/permissions"

export const metadata = {
  title: "Dashboard — Poker Manager",
}

export default async function DashboardPage() {
  const user = await getCurrentUser()

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Bienvenido, {user?.name ?? "usuario"}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Esta es la base del Módulo 00: infraestructura, autenticación y
          autorización por roles. Las pantallas de caja, mesas, compras,
          créditos y liquidaciones se construyen en los módulos siguientes — ver{" "}
          <code className="bg-muted rounded px-1 py-0.5">docs/MODULES.md</code>.
        </CardContent>
      </Card>
    </div>
  )
}
