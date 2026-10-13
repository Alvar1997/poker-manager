"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Pencil, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { apiRequest } from "@/lib/api-client"
import { positiveMoneySchema } from "@/lib/money"
import { handleFormError } from "@/modules/settings/components/form-helpers"

const schema = z.object({
  value: positiveMoneySchema,
  name: z.string().trim().max(40),
  color: z.string().trim().max(40),
  sortOrder: z.string().regex(/^\d{1,4}$/, "Número entero de 0 a 9999"),
})

type Values = z.infer<typeof schema>

export function DenominationFormDialog({
  chipSetId,
  chipSetName,
  denomination,
}: {
  chipSetId: string
  chipSetName: string
  denomination?: {
    id: string
    value: string
    name: string | null
    color: string | null
    sortOrder: number
  }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const isEdit = Boolean(denomination)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      value: denomination?.value ?? "",
      name: denomination?.name ?? "",
      color: denomination?.color ?? "",
      sortOrder: String(denomination?.sortOrder ?? 0),
    },
  })

  async function onSubmit(values: Values) {
    const body = { ...values, sortOrder: Number(values.sortOrder) }
    try {
      if (denomination) {
        await apiRequest(`/api/denominations/${denomination.id}`, {
          method: "PATCH",
          body,
        })
        toast.success("Denominación actualizada")
      } else {
        await apiRequest(`/api/chip-sets/${chipSetId}/denominations`, {
          method: "POST",
          body,
        })
        toast.success("Denominación agregada")
        form.reset()
      }
      setOpen(false)
      router.refresh()
    } catch (error) {
      handleFormError(form, error)
    }
  }

  const submitting = form.formState.isSubmitting

  return (
    <>
      {isEdit ? (
        <Button
          variant="ghost"
          size="icon-lg"
          onClick={() => setOpen(true)}
          aria-label={`Editar denominación de $${denomination?.value}`}
        >
          <Pencil />
        </Button>
      ) : (
        <Button className="h-11 md:h-9" onClick={() => setOpen(true)}>
          <Plus />
          Agregar denominación
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>
            {isEdit ? "Editar denominación" : "Nueva denominación"}
          </DialogTitle>
          <DialogDescription>
            {chipSetName}. Registra solo fichas que existan físicamente; las
            cantidades se manejan en el inventario, no aquí.
          </DialogDescription>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              <FormField
                control={form.control}
                name="value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Valor (MXN)</FormLabel>
                    <FormControl>
                      <Input
                        className="h-11 md:h-9"
                        inputMode="decimal"
                        placeholder="25"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Mayor que cero; no puede repetirse dentro de este juego.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Color</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 md:h-9"
                          placeholder="Verde"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nombre</FormLabel>
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
                name="sortOrder"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Orden</FormLabel>
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
              <Button
                type="submit"
                className="h-11 w-full md:h-9"
                disabled={submitting}
              >
                {submitting ? <Loader2 className="animate-spin" /> : null}
                {isEdit ? "Guardar cambios" : "Agregar"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}
