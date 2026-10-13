"use client"

import { LogOut } from "lucide-react"
import { signOut } from "next-auth/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const ROLE_LABEL: Record<string, string> = {
  SUPERADMIN: "Superadmin",
  PARTNER: "Socio",
  CASHIER: "Cajero",
}

export function DashboardHeader({
  userName,
  role,
}: {
  userName: string
  role: string
}) {
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Poker Manager</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{userName}</span>
          <Badge variant="secondary">{ROLE_LABEL[role] ?? role}</Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Cerrar sesión"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  )
}
