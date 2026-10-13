"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/shared/native-select"
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
import { handleFormError } from "@/modules/settings/components/form-helpers"
import {
  DATE_FORMAT_LABEL,
  DATE_FORMATS,
  TIME_FORMAT_LABEL,
  TIME_FORMATS,
} from "@/modules/settings/settings.schemas"
import type { BusinessSettingsView } from "@/modules/settings/settings.service"

const formSchema = z.object({
  businessName: z.string().trim().min(2, "Mínimo 2 caracteres").max(80),
  displayName: z.string().trim().max(80),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (v) => v === "" || /^https:\/\//.test(v) || v.startsWith("/"),
      "Usa una URL https:// o una ruta del sitio (/logo.png)"
    ),
  dateFormat: z.enum(DATE_FORMATS),
  timeFormat: z.enum(TIME_FORMATS),
})

type FormValues = z.infer<typeof formSchema>

export function GeneralSettingsForm({
  settings,
}: {
  settings: BusinessSettingsView
}) {
  const router = useRouter()
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      businessName: settings.businessName,
      displayName: settings.displayName ?? "",
      logoUrl: settings.logoUrl ?? "",
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
    },
  })

  async function onSubmit(values: FormValues) {
    const dirty = form.formState.dirtyFields
    const body = Object.fromEntries(
      Object.entries(values).filter(([key]) => dirty[key as keyof FormValues])
    )
    if (Object.keys(body).length === 0) return
    try {
      await apiRequest("/api/settings/general", { method: "PATCH", body })
      toast.success("Configuración actualizada")
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
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="businessName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre del negocio</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="displayName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nombre para mostrar (opcional)</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="logoUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>URL del logotipo (opcional)</FormLabel>
              <FormControl>
                <Input
                  className="h-11 md:h-9"
                  inputMode="url"
                  placeholder="https://…"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="dateFormat"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Formato de fecha</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {DATE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {DATE_FORMAT_LABEL[f]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="timeFormat"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Formato de hora</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {TIME_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {TIME_FORMAT_LABEL[f]}
                      </option>
                    ))}
                  </NativeSelect>
                </FormControl>
                <FormDescription>
                  Preferencia guardada; las pantallas actuales aún usan el
                  formato regional es-MX.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <Button
          type="submit"
          className="h-11 w-full md:h-9 md:w-auto"
          disabled={isSubmitting || !isDirty}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : null}
          Guardar cambios
        </Button>
      </form>
    </Form>
  )
}
