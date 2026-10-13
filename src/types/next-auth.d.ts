import type { DefaultSession } from "next-auth"

import type { Role } from "@/config/permission-matrix"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role: Role
      isActive: boolean
      sessionVersion: number
    } & DefaultSession["user"]
  }

  interface User {
    id: string
    role: Role
    isActive: boolean
    sessionVersion: number
  }
}

// `next-auth/jwt` solo re-exporta `@auth/core/jwt`: la ampliación debe
// declararse sobre el módulo original para que TypeScript la combine.
declare module "@auth/core/jwt" {
  interface JWT {
    id: string
    role: Role
    isActive: boolean
    sessionVersion: number
  }
}
