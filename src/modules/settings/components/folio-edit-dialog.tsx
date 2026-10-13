"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Pencil } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { apiRequest } from "@/lib/api-client"
import { handleFormError } from "@/modules/settings/components/form-helpers"
import { formatFolio } from "@/modules/settings/settings.schemas"

const schema = z.object({
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{1,6}$/, "Prefijo de 1 a 6 letras"),
  padding: z.string().regex(/^([1-9]|1[0-2])$/, "Entre 1 y 12 dígitos"),
  nextNumber: z.string().regex(/^[1-9]\d{0,8}$/, "Entero mayor que cero"),
})

type Values = z.infer<typeof schema>

export function FolioEditDialog({
  folio,
}: {
  folio: {
    id: string
    label: string
    prefix: string
    padding: number
    nextNumber: number
  }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      prefix: folio.prefix,
      padding: String(folio.padding),
      nextNumber: String(folio.nextNumber),
    },
  })
  const values = useWatch({ control: form.control })
  const parsed = schema.safeParse(values)
  const preview = parsed.success
    ? formatFolio(
        parsed.data.prefix.toUpperCase(),
        Number(parsed.data.nextNumber),
        Number(parsed.data.padding)
      )
    : "—"

  async function onSubmit(v: Values) {
    try {
      await apiRequest(`/api/settings/folios/${folio.id}`, {
        method: "PATCH",
        body: {
          prefix: v.prefix.toUpperCase(),
          padding: Number(v.padding),
          nextNumber: Number(v.nextNumber),
        },
      })
      toast.success("Consecutivo actualizado")
      setOpen(false)
      router.refresh()
    } catch (error) {
      handleFormError(form, error)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-8"
        onClick={() => setOpen(true)}
        aria-label={`Editar formato de ${folio.label}`}
      >
        <Pencil />
        Editar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Formato: {folio.label}</DialogTitle>
          <DialogDescription>
            Solo editable antes del primer folio emitido.
          </DialogDescription>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="prefix"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Prefijo</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 uppercase md:h-9"
                          autoCapitalize="characters"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="padding"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Dígitos</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 md:h-9"
                          inputMode="numeric"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nextNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Siguiente</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 md:h-9"
                          inputMode="numeric"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-sm">
                Vista previa: <code className="font-mono">{preview}</code>
              </p>
              <Button
                type="submit"
                className="h-11 w-full md:h-9"
                disabled={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Guardar
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}
