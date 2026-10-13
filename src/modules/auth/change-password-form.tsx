"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { signOut } from "next-auth/react"
import { useState } from "react"
import { useForm } from "react-hook-form"

import { PasswordInput } from "@/components/shared/password-input"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import {
  changePasswordSchema,
  PASSWORD_MIN_LENGTH,
  type ChangePasswordInput,
} from "@/modules/auth/auth.schemas"

/**
 * Cambio de contraseña propia. Al terminar, el servidor invalida todas
 * las sesiones (incluida esta), así que se cierra sesión y se vuelve al
 * login con un aviso.
 */
export function ChangePasswordForm({
  submitLabel = "Cambiar contraseña",
}: {
  submitLabel?: string
}) {
  const [formError, setFormError] = useState<string | null>(null)
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  })

  async function onSubmit(values: ChangePasswordInput) {
    setFormError(null)
    try {
      await apiRequest("/api/auth/change-password", {
        method: "POST",
        body: values,
      })
      await signOut({ callbackUrl: "/login?passwordChanged=1" })
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldIssues.length > 0) {
        for (const issue of error.fieldIssues) {
          form.setError(issue.path as keyof ChangePasswordInput, {
            message: issue.message,
          })
        }
        return
      }
      setFormError(
        error instanceof Error
          ? error.message
          : "No se pudo cambiar la contraseña"
      )
    }
  }

  const submitting = form.formState.isSubmitting

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Contraseña actual</FormLabel>
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
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nueva contraseña</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  className="h-11 md:h-9"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Mínimo {PASSWORD_MIN_LENGTH} caracteres, con letras y números.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirmar nueva contraseña</FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="new-password"
                  className="h-11 md:h-9"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {formError ? (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        ) : null}

        <Button
          type="submit"
          className="h-11 w-full md:h-9 md:w-auto"
          disabled={submitting}
        >
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
        <p className="text-muted-foreground text-xs">
          Por seguridad se cerrarán todas tus sesiones abiertas y tendrás que
          iniciar sesión de nuevo.
        </p>
      </form>
    </Form>
  )
}
