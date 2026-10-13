"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import Image from "next/image"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"

import { PasswordInput } from "@/components/shared/password-input"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  LOGIN_RATE_LIMITED_CODE,
  loginSchema,
  type LoginInput,
} from "@/modules/auth/auth.schemas"

/** Solo rutas internas: evita redirecciones abiertas vía ?callbackUrl=. */
export function safeCallbackUrl(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard"
  }
  return value
}

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"))
  const passwordChanged = searchParams.get("passwordChanged") === "1"
  const [serverError, setServerError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(values: LoginInput) {
    setServerError(null)
    setIsSubmitting(true)

    try {
      const result = await signIn("credentials", {
        ...values,
        redirect: false,
      })

      if (result?.error) {
        setServerError(
          result.code === LOGIN_RATE_LIMITED_CODE
            ? "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo."
            : "Correo o contraseña incorrectos."
        )
        setIsSubmitting(false)
        return
      }

      router.replace(callbackUrl)
      router.refresh()
    } catch {
      setServerError("No se pudo conectar con el servidor. Revisa tu conexión.")
      setIsSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center gap-3 text-center">
        <Image
          src="/icons/icon-192.png"
          alt=""
          width={64}
          height={64}
          priority
          className="mx-auto rounded-2xl"
        />
        <div className="space-y-1">
          <p className="text-lg font-semibold tracking-tight">Poker Manager</p>
          <h1 className="text-muted-foreground text-sm font-normal">
            Iniciar sesión
          </h1>
        </div>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            {passwordChanged ? (
              <p
                role="status"
                className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"
              >
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                Contraseña actualizada. Inicia sesión con tu nueva contraseña.
              </p>
            ) : null}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Correo</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      inputMode="email"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="nombre@ejemplo.com"
                      className="h-11 md:h-9"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contraseña</FormLabel>
                  <FormControl>
                    <PasswordInput
                      autoComplete="current-password"
                      className="h-11 md:h-9"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {serverError ? (
              <p
                role="alert"
                className="text-destructive flex items-center gap-2 text-sm"
              >
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                {serverError}
              </p>
            ) : null}

            <Button
              type="submit"
              className="h-11 w-full text-base md:h-9 md:text-sm"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {isSubmitting ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
