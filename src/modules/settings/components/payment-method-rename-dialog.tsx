"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Pencil } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
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

const schema = z.object({
  name: z.string().trim().min(2, "Mínimo 2 caracteres").max(80),
})

export function PaymentMethodRenameDialog({
  method,
}: {
  method: { id: string; name: string }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: method.name },
  })

  async function onSubmit(values: z.infer<typeof schema>) {
    try {
      await apiRequest(`/api/payment-methods/${method.id}`, {
        method: "PATCH",
        body: values,
      })
      toast.success("Método de pago actualizado")
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
        aria-label={`Renombrar ${method.name}`}
      >
        <Pencil />
        Renombrar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Renombrar método de pago</DialogTitle>
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
                    <FormLabel>Nombre visible</FormLabel>
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
