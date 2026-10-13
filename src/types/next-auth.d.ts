import type { DefaultSession } from "next-auth"

type AppRole = "SUPERADMIN" | "PARTNER" | "CASHIER"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role: AppRole
      isActive: boolean
    } & DefaultSession["user"]
  }

  interface User {
    id: string
    role: AppRole
    isActive: boolean
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string
    role: AppRole
    isActive: boolean
  }
}
