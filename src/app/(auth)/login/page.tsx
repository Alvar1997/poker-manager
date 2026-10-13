import { redirect } from "next/navigation"
import { Suspense } from "react"

import { getCurrentUser } from "@/config/permissions"
import { Loading } from "@/components/shared/loading"
import { LoginForm } from "@/modules/auth/login-form"

export const metadata = {
  title: "Iniciar sesión — Poker Manager",
}

export default async function LoginPage() {
  const user = await getCurrentUser()
  if (user) {
    redirect("/dashboard")
  }

  return (
    <Suspense fallback={<Loading />}>
      <LoginForm />
    </Suspense>
  )
}
