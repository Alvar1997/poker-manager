"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { Input } from "@/components/ui/input"
import { apiRequest } from "@/lib/api-client"
import { isValidClabe } from "@/lib/clabe"
import { handleFormError } from "@/modules/settings/components/form-helpers"

const digits = (v: string) => v.replace(/[\s-]/g, "")

const schema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(80),
  bankName: z.string().trim().max(80),
  accountHolder: z.string().trim().max(120),
  accountNumber: z
    .string()
    .refine((v) => v === "" || /^\d{6,20}$/.test(digits(v)), "6–20 dígitos"),
  clabe: z
    .string()
    .refine(
      (v) => v === "" || isValidClabe(digits(v)),
      "CLABE inválida (18 dígitos con dígito de control)"
    ),
})

type Values = z.infer<typeof schema>

/**
 * Los números nunca se precargan (el servidor no los devuelve): dejar el
 * campo vacío conserva el valor guardado. Si la cuenta ya tenía números,
 * capturar otros REEMPLAZA la cuenta (se conserva la anterior en el
 * historial), por eso se pide confirmación.
 */
export function BankAccountForm({
  account,
}: {
  account: {
    name: string
    bankName: string | null
    accountHolder: string | null
    isConfigured: boolean
  }
}) {
  const router = useRouter()
  const [pending, setPending] = useState<Record<string, unknown> | null>(null)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: account.name,
      bankName: account.bankName ?? "",
      accountHolder: account.accountHolder ?? "",
      accountNumber: "",
      clabe: "",
    },
  })

  async function send(body: Record<string, unknown>) {
    try {
      await apiRequest("/api/settings/bank-account", { method: "PATCH", body })
      toast.success("Cuenta bancaria actualizada")
      form.reset({ ...form.getValues(), accountNumber: "", clabe: "" })
      router.refresh()
    } catch (error) {
      handleFormError(form, error)
    } finally {
      setPending(null)
    }
  }

  async function onSubmit(values: Values) {
    const dirty = form.formState.dirtyFields
    const body: Record<string, unknown> = {}
    if (dirty.name) body.name = values.name
    if (dirty.bankName) body.bankName = values.bankName
    if (dirty.accountHolder) body.accountHolder = values.accountHolder
    if (values.accountNumber) body.accountNumber = digits(values.accountNumber)
    if (values.clabe) body.clabe = digits(values.clabe)
    if (Object.keys(body).length === 0) return

    const replacesNumbers = Boolean(body.accountNumber || body.clabe)
    if (replacesNumbers && account.isConfigured) {
      setPending(body)
      return
    }
    await send(body)
  }

  const submitting = form.formState.isSubmitting

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
        autoComplete="off"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre interno</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="bankName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Banco</FormLabel>
                <FormControl>
                  <Input className="h-11 md:h-9" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="accountHolder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Titular</FormLabel>
                <FormControl>
                  <Input className="h-11 md:h-9" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="accountNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Número de cuenta</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" inputMode="numeric" {...field} />
              </FormControl>
              <FormDescription>
                Déjalo vacío para conservar el guardado.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="clabe"
          render={({ field }) => (
            <FormItem>
              <FormLabel>CLABE (18 dígitos)</FormLabel>
              <FormControl>
                <Input
                  className="h-11 md:h-9"
                  inputMode="numeric"
                  maxLength={22}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Déjalo vacío para conservar la guardada.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <p className="text-muted-foreground text-xs">
          Nunca captures contraseñas, claves de banca electrónica ni tokens: el
          sistema no los necesita ni los acepta.
        </p>
        <Button
          type="submit"
          className="h-11 w-full md:h-9 md:w-auto"
          disabled={submitting}
        >
          {submitting ? <Loader2 className="animate-spin" /> : null}
          Guardar cuenta
        </Button>
      </form>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿Reemplazar la cuenta receptora?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Se registrará una cuenta nueva como principal y la actual quedará
              inactiva en el historial. Las transferencias futuras se asociarán
              a la nueva cuenta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button onClick={() => pending && send(pending)}>Reemplazar</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  )
}
