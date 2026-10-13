"use client"

import { LogOut } from "lucide-react"
import { signOut } from "next-auth/react"

import { Button } from "@/components/ui/button"

export function SignOutButton() {
  return (
    <Button
      variant="outline"
      className="h-11 md:h-9"
      onClick={() => signOut({ callbackUrl: "/login" })}
    >
      <LogOut />
      Cerrar sesión
    </Button>
  )
}
