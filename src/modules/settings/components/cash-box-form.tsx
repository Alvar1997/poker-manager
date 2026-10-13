"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import {
  updateCashBoxSchema,
  type UpdateCashBoxInput,
} from "@/modules/settings/settings.schemas"

export function CashBoxForm({ name }: { name: string }) {
  const router = useRouter()
  const form = useForm<UpdateCashBoxInput>({
    resolver: zodResolver(updateCashBoxSchema),
    defaultValues: { name },
  })

  async function onSubmit(values: UpdateCashBoxInput) {
    try {
      await apiRequest("/api/settings/cash-box", {
        method: "PATCH",
        body: values,
      })
      toast.success("Caja actualizada")
      form.reset(values)
      router.refresh()
    } catch (error) {
      handleFormError(form, error)
    }
  }

  const { isSubmitting, isDirty } = form.formState
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="flex-1">
              <FormLabel>Nombre de la caja</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          className="h-11 md:h-9"
          disabled={isSubmitting || !isDirty}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : null}
          Guardar nombre
        </Button>
      </form>
    </Form>
  )
}
