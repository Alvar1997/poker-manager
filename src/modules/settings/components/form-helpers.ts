import type { FieldValues, Path, UseFormReturn } from "react-hook-form"
import { toast } from "sonner"

import { ApiClientError } from "@/lib/api-client"

/**
 * Lleva los errores del servidor al formulario: errores por campo (400)
 * junto al campo; el resto (403/409/422…) como aviso.
 */
export function handleFormError<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
  fallback = "No se pudo guardar"
) {
  if (error instanceof ApiClientError && error.fieldIssues.length > 0) {
    for (const issue of error.fieldIssues) {
      form.setError(issue.path as Path<T>, { message: issue.message })
    }
    return
  }
  toast.error(error instanceof Error ? error.message : fallback)
}
