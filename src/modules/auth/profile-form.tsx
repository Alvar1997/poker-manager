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
import { apiRequest, ApiClientError } from "@/lib/api-client"
import {
  updateProfileSchema,
  type UpdateProfileInput,
} from "@/modules/auth/auth.schemas"

export function ProfileForm({ initialName }: { initialName: string }) {
  const router = useRouter()
  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { name: initialName },
  })

  async function onSubmit(values: UpdateProfileInput) {
    try {
      await apiRequest("/api/auth/profile", { method: "PATCH", body: values })
      toast.success("Perfil actualizado")
      form.reset(values)
      router.refresh()
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldIssues.length > 0) {
        form.setError("name", { message: error.fieldIssues[0].message })
        return
      }
      toast.error(error instanceof Error ? error.message : "No se pudo guardar")
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
              <FormLabel>Nombre</FormLabel>
              <FormControl>
                <Input autoComplete="name" className="h-11 md:h-9" {...field} />
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
