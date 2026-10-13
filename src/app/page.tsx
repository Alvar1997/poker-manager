import { redirect } from "next/navigation"

import { getCurrentUser } from "@/config/permissions"

export default async function RootPage() {
  const user = await getCurrentUser()
  redirect(user ? "/dashboard" : "/login")
}
