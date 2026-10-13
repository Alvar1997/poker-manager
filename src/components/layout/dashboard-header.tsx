"use client"

import { LogOut, Menu } from "lucide-react"
import { signOut } from "next-auth/react"
import { useState } from "react"

import { AppNav } from "@/components/layout/app-nav"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ROLE_LABEL, type Role } from "@/config/permission-matrix"

export function DashboardHeader({
  userName,
  role,
  showNav = true,
}: {
  userName: string
  role: Role
  showNav?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="bg-background/95 sticky top-0 z-40 flex items-center justify-between gap-2 border-b px-4 py-2 backdrop-blur">
      <div className="flex items-center gap-1">
        {showNav ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="md:hidden"
            aria-label="Abrir menú"
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </Button>
        ) : null}
        <span className="font-semibold">Poker Manager</span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-muted-foreground hidden truncate sm:inline">
            {userName}
          </span>
          <Badge variant="secondary" data-testid="current-role">
            {ROLE_LABEL[role]}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Cerrar sesión"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="size-4" />
        </Button>
      </div>

      {showNav ? (
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogContent className="top-0 left-0 h-dvh max-h-dvh w-[85vw] max-w-xs translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none rounded-r-xl pt-[max(1rem,env(safe-area-inset-top))] sm:max-w-xs">
            <DialogTitle className="px-3 font-semibold">Menú</DialogTitle>
            <AppNav role={role} onNavigate={() => setMenuOpen(false)} />
          </DialogContent>
        </Dialog>
      ) : null}
    </header>
  )
}
