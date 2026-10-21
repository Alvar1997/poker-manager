"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Pencil, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/shared/native-select"
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
import { catalogCodeSchema } from "@/modules/settings/settings.schemas"

export type ChipSetOption = { id: string; name: string; code: string }

type TableValues = {
  id: string
  code: string
  name: string
  smallBlind: string
  bigBlind: string
  sortOrder: number
  chipSetId: string
}

const baseSchema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(80),
  smallBlind: positiveMoneySchema,
  bigBlind: positiveMoneySchema,
  defaultChipSetId: z.string().min(1, "Selecciona un juego de fichas"),
  sortOrder: z.string().regex(/^\d{1,4}$/, "Número entero de 0 a 9999"),
})

/** Alta (sin `table`) o edición de una mesa. El código solo se fija al crear. */
export function TableFormDialog({
  table,
  chipSets,
}: {
  table?: TableValues
  chipSets: ChipSetOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const isEdit = Boolean(table)
  const schema = isEdit
    ? baseSchema.extend({ code: z.string() })
    : baseSchema.extend({ code: catalogCodeSchema })

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: table?.code ?? "",
      name: table?.name ?? "",
      smallBlind: table?.smallBlind ?? "",
      bigBlind: table?.bigBlind ?? "",
      defaultChipSetId: table?.chipSetId ?? "",
      sortOrder: String(table?.sortOrder ?? 0),
    },
  })

  async function onSubmit(values: z.infer<typeof schema>) {
    const { code, sortOrder, ...rest } = values
    const body = { ...rest, sortOrder: Number(sortOrder) }
    try {
      if (table) {
        await apiRequest(`/api/tables/${table.id}`, { method: "PATCH", body })
        toast.success("Mesa actualizada")
      } else {
        await apiRequest("/api/tables", {
          method: "POST",
          body: { ...body, code },
        })
        toast.success("Mesa creada")
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
          aria-label={`Editar ${table?.name}`}
        >
          <Pencil />
          Editar
        </Button>
      ) : (
        <Button className="h-11 md:h-9" onClick={() => setOpen(true)}>
          <Plus />
          Nueva mesa
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogTitle>{isEdit ? "Editar mesa" : "Nueva mesa"}</DialogTitle>
          <DialogDescription>
            Cambiar ciegas o juego no altera sesiones anteriores.
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
                        placeholder="TABLE_50_50"
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
                      <Input
                        className="h-11 md:h-9"
                        placeholder="Mesa 50/50"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="smallBlind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ciega chica</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 md:h-9"
                          inputMode="decimal"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bigBlind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ciega grande</FormLabel>
                      <FormControl>
                        <Input
                          className="h-11 md:h-9"
                          inputMode="decimal"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="defaultChipSetId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Inventario de fichas</FormLabel>
                    <FormControl>
                      <NativeSelect {...field}>
                        <option value="">Selecciona…</option>
                        {chipSets.map((set) => (
                          <option key={set.id} value={set.id}>
                            {set.name} ({set.code})
                          </option>
                        ))}
                      </NativeSelect>
                    </FormControl>
                    <FormDescription>
                      Todas las mesas comparten el mismo inventario físico de
                      fichas.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
                {isEdit ? "Guardar cambios" : "Crear mesa"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}
