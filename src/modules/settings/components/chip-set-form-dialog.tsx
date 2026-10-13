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
import { handleFormError } from "@/modules/settings/components/form-helpers"
import { catalogCodeSchema } from "@/modules/settings/settings.schemas"

const base = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(80),
  description: z.string().trim().max(300),
})

export function ChipSetFormDialog({
  chipSet,
}: {
  chipSet?: {
    id: string
    code: string
    name: string
    description: string | null
  }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const isEdit = Boolean(chipSet)
  const schema = isEdit
    ? base.extend({ code: z.string() })
    : base.extend({ code: catalogCodeSchema })

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: chipSet?.code ?? "",
      name: chipSet?.name ?? "",
      description: chipSet?.description ?? "",
    },
  })

  async function onSubmit(values: z.infer<typeof schema>) {
    const { code, ...rest } = values
    try {
      if (chipSet) {
        await apiRequest(`/api/chip-sets/${chipSet.id}`, {
          method: "PATCH",
          body: rest,
        })
        toast.success("Juego de fichas actualizado")
      } else {
        await apiRequest("/api/chip-sets", {
          method: "POST",
          body: { ...rest, code },
        })
        toast.success("Juego de fichas creado")
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
          variant="outline"
          className="h-11 md:h-8"
          onClick={() => setOpen(true)}
        >
          <Pencil />
          Editar juego
        </Button>
      ) : (
        <Button className="h-11 md:h-9" onClick={() => setOpen(true)}>
          <Plus />
          Nuevo juego
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>
            {isEdit ? "Editar juego de fichas" : "Nuevo juego de fichas"}
          </DialogTitle>
          <DialogDescription>
            Un juego es un conjunto FÍSICO de fichas con inventario propio. Las
            denominaciones se agregan después.
          </DialogDescription>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Código</FormLabel>
                    <FormControl>
                      <Input
                        className="h-11 font-mono uppercase md:h-9"
                        placeholder="CHIPSET_50_50"
                        autoCapitalize="characters"
                        disabled={isEdit}
                        {...field}
                      />
                    </FormControl>
                    {isEdit ? (
                      <FormDescription>
                        El código interno no se puede cambiar.
                      </FormDescription>
                    ) : null}
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
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Descripción (opcional)</FormLabel>
                    <FormControl>
                      <Input className="h-11 md:h-9" {...field} />
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
                {isEdit ? "Guardar cambios" : "Crear juego"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}
