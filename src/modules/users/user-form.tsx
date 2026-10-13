"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/shared/native-select"
import { TemporaryPasswordNotice } from "@/components/shared/temporary-password-notice"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { ROLE_LABEL, ROLES, type Role } from "@/config/permission-matrix"
import { apiRequest, ApiClientError } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { emailSchema, personNameSchema } from "@/modules/auth/auth.schemas"
import type { CreatedUserResult, PublicUser } from "@/modules/users/user.dto"
import { roleSchema } from "@/modules/users/user.schemas"

const ROLE_HELP: Record<Role, string> = {
  SUPERADMIN:
    "Control total, incluida la administración de usuarios y seguridad.",
  PARTNER: "Operación y finanzas completas, sin administración de usuarios.",
  CASHIER: "Operación de sesiones y caja central.",
}

// Mismo contrato que los schemas del servidor (que son los que cuentan).
const formSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  role: roleSchema,
  isActive: z.boolean(),
})

type FormValues = z.input<typeof formSchema>

function applyServerErrors(
  form: ReturnType<typeof useForm<FormValues>>,
  error: unknown
): string | null {
  if (error instanceof ApiClientError) {
    if (error.code === "CONFLICT" && /correo/i.test(error.message)) {
      form.setError("email", { message: error.message })
      return null
    }
    if (error.fieldIssues.length > 0) {
      for (const issue of error.fieldIssues) {
        form.setError(issue.path as keyof FormValues, {
          message: issue.message,
        })
      }
      return null
    }
    return error.message
  }
  return "Operación fallida"
}

export function UserCreateForm() {
  const [created, setCreated] = useState<CreatedUserResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", email: "", role: "CASHIER", isActive: true },
  })

  async function onSubmit(values: FormValues) {
    setFormError(null)
    try {
      const result = await apiRequest<CreatedUserResult>("/api/users", {
        method: "POST",
        body: values,
      })
      setCreated(result)
    } catch (error) {
      setFormError(applyServerErrors(form, error))
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <p role="status" className="font-medium">
          Usuario {created.user.name} creado como{" "}
          {ROLE_LABEL[created.user.role]}.
        </p>
        <TemporaryPasswordNotice
          email={created.user.email}
          password={created.temporaryPassword}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href="/dashboard/users"
            className={cn(buttonVariants(), "h-11 md:h-9")}
          >
            Ir a usuarios
          </Link>
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => {
              form.reset()
              setCreated(null)
            }}
          >
            Crear otro
          </Button>
        </div>
      </div>
    )
  }

  return (
    <UserFields
      form={form}
      onSubmit={onSubmit}
      formError={formError}
      submitLabel="Crear usuario"
      showStatus
    />
  )
}

export function UserEditForm({
  user,
  isSelf,
}: {
  user: PublicUser
  isSelf: boolean
}) {
  const router = useRouter()
  const [formError, setFormError] = useState<string | null>(null)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
    },
  })

  async function onSubmit(values: FormValues) {
    setFormError(null)
    const dirty = form.formState.dirtyFields
    // Solo se envían los campos modificados (y nunca el rol propio).
    const body: Record<string, unknown> = {}
    if (dirty.name) body.name = values.name
    if (dirty.email) body.email = values.email
    if (dirty.role && !isSelf) body.role = values.role
    if (Object.keys(body).length === 0) return

    try {
      const updated = await apiRequest<PublicUser>(`/api/users/${user.id}`, {
        method: "PATCH",
        body,
      })
      toast.success("Usuario actualizado")
      form.reset({
        name: updated.name,
        email: updated.email,
        role: updated.role,
        isActive: updated.isActive,
      })
      router.refresh()
    } catch (error) {
      setFormError(applyServerErrors(form, error))
    }
  }

  return (
    <UserFields
      form={form}
      onSubmit={onSubmit}
      formError={formError}
      submitLabel="Guardar cambios"
      roleLocked={isSelf}
    />
  )
}

function UserFields({
  form,
  onSubmit,
  formError,
  submitLabel,
  showStatus = false,
  roleLocked = false,
}: {
  form: ReturnType<typeof useForm<FormValues>>
  onSubmit: (values: FormValues) => Promise<void>
  formError: string | null
  submitLabel: string
  showStatus?: boolean
  roleLocked?: boolean
}) {
  const submitting = form.formState.isSubmitting
  const role = form.watch("role")

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre</FormLabel>
              <FormControl>
                <Input autoComplete="off" className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
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
                  autoCapitalize="none"
                  autoComplete="off"
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
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rol</FormLabel>
              <FormControl>
                <NativeSelect disabled={roleLocked} {...field}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </NativeSelect>
              </FormControl>
              <FormDescription>
                {roleLocked
                  ? "No puedes cambiar tu propio rol."
                  : ROLE_HELP[role as Role]}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {showStatus ? (
          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-5 accent-current"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                  Cuenta activa (puede iniciar sesión)
                </label>
              </FormItem>
            )}
          />
        ) : null}
        {showStatus ? (
          <p className="text-muted-foreground text-xs">
            Se generará una credencial temporal segura que verás una sola vez.
            El usuario deberá cambiarla en su primer acceso.
          </p>
        ) : null}

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
      </form>
    </Form>
  )
}
