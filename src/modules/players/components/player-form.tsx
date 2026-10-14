"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
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
import { apiRequest, ApiClientError } from "@/lib/api-client"
import {
  DEFAULT_PHONE_COUNTRY,
  formatPhone,
  normalizePhone,
  type PhoneCountryOption,
} from "@/lib/phone"
import {
  WHATSAPP_CONSENT_NOTICE,
  WHATSAPP_CONSENT_NOTICE_VERSION,
} from "@/modules/players/consent-notice"
import {
  PLAYER_NAME_MAX,
  PLAYER_NICKNAME_MAX,
  PLAYER_NOTES_MAX,
} from "@/modules/players/player.schemas"
import type { PlayerView } from "@/modules/players/player.service"

const formSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "El nombre es obligatorio (mínimo 2 caracteres)")
      .max(PLAYER_NAME_MAX),
    nickname: z.string().trim().max(PLAYER_NICKNAME_MAX),
    phoneCountry: z.string().min(2),
    phone: z.string().trim().min(1, "El teléfono es obligatorio"),
    phoneChangeReason: z.string().trim().max(200),
    notes: z
      .string()
      .max(PLAYER_NOTES_MAX, `Máximo ${PLAYER_NOTES_MAX} caracteres`),
    whatsappConsent: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (
      data.phone &&
      !normalizePhone(
        data.phone,
        data.phoneCountry as typeof DEFAULT_PHONE_COUNTRY
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message:
          "Teléfono inválido para el país seleccionado. Si es de otro país, elige el país o escribe +código.",
      })
    }
  })

type Values = z.infer<typeof formSchema>

type ExistingRef = { id: string; name: string }

/**
 * Alta (sin `player`) o edición de un jugador. No hay campos de crédito,
 * deuda ni saldo. En edición, el estado y el consentimiento se gestionan
 * con acciones separadas en el perfil.
 */
export function PlayerForm({
  countries,
  player,
}: {
  countries: PhoneCountryOption[]
  player?: PlayerView
}) {
  const router = useRouter()
  const isEdit = Boolean(player)
  const [duplicate, setDuplicate] = useState<ExistingRef | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: player?.name ?? "",
      nickname: player?.nickname ?? "",
      phoneCountry: player?.countryCode ?? DEFAULT_PHONE_COUNTRY,
      phone: player ? player.phoneDisplay : "",
      phoneChangeReason: "",
      notes: player?.notes ?? "",
      // WA-03: siempre desmarcado.
      whatsappConsent: false,
    },
  })

  const [phone, phoneCountry, consent] = useWatch({
    control: form.control,
    name: ["phone", "phoneCountry", "whatsappConsent"],
  })
  const normalized = phone
    ? normalizePhone(phone, phoneCountry as typeof DEFAULT_PHONE_COUNTRY)
    : null
  const phoneChanged =
    isEdit && normalized !== null && normalized.e164 !== player?.phone

  async function onSubmit(values: Values) {
    setDuplicate(null)
    setFormError(null)
    const common = {
      name: values.name,
      nickname: values.nickname,
      notes: values.notes,
    }
    try {
      if (player) {
        const body: Record<string, unknown> = { ...common }
        if (phoneChanged) {
          body.phone = values.phone
          body.phoneCountry = values.phoneCountry
          body.phoneChangeReason = values.phoneChangeReason
        }
        await apiRequest(`/api/players/${player.id}`, { method: "PATCH", body })
        toast.success("Jugador actualizado")
        router.push(`/dashboard/jugadores/${player.id}`)
        router.refresh()
      } else {
        const created = await apiRequest<PlayerView>("/api/players", {
          method: "POST",
          body: {
            ...common,
            phone: values.phone,
            phoneCountry: values.phoneCountry,
            ...(values.whatsappConsent
              ? {
                  whatsappConsent: {
                    noticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION,
                    source: "IN_PERSON",
                    confirmedByPlayer: true,
                  },
                }
              : {}),
          },
        })
        toast.success("Jugador registrado")
        router.push(`/dashboard/jugadores/${created.id}`)
      }
    } catch (error) {
      if (error instanceof ApiClientError) {
        const details = error.details as
          { field?: string; existingPlayer?: ExistingRef } | undefined
        if (error.code === "CONFLICT" && details?.field === "phone") {
          form.setError("phone", { message: error.message })
          setDuplicate(details.existingPlayer ?? null)
          return
        }
        if (error.fieldIssues.length > 0) {
          for (const issue of error.fieldIssues) {
            form.setError(issue.path.split(".")[0] as keyof Values, {
              message: issue.message,
            })
          }
          return
        }
      }
      setFormError(
        error instanceof Error ? error.message : "No se pudo guardar"
      )
    }
  }

  const submitting = form.formState.isSubmitting

  return (
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
              <FormLabel>Nombre completo</FormLabel>
              <FormControl>
                <Input
                  className="h-11 md:h-9"
                  autoComplete="off"
                  autoCapitalize="words"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="nickname"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Apodo (opcional)</FormLabel>
              <FormControl>
                <Input className="h-11 md:h-9" autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
          <FormField
            control={form.control}
            name="phoneCountry"
            render={({ field }) => (
              <FormItem>
                <FormLabel>País del teléfono</FormLabel>
                <FormControl>
                  <NativeSelect {...field}>
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} (+{c.callingCode})
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
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Teléfono</FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="871 123 4567"
                    className="h-11 md:h-9"
                    {...field}
                  />
                </FormControl>
                {normalized ? (
                  <FormDescription className="flex items-center gap-1">
                    <CheckCircle2
                      className="size-3.5 text-emerald-600"
                      aria-hidden="true"
                    />
                    Se guardará como{" "}
                    <span data-testid="phone-preview">
                      {formatPhone(normalized.e164)}
                    </span>
                  </FormDescription>
                ) : (
                  <FormDescription>
                    Número a 10 dígitos para México; de otro país, elige el país
                    o escribe +código.
                  </FormDescription>
                )}
                <FormMessage />
                {duplicate ? (
                  <Link
                    href={`/dashboard/jugadores/${duplicate.id}`}
                    className="text-primary inline-flex min-h-11 items-center gap-1 text-sm underline md:min-h-0"
                    data-testid="duplicate-link"
                  >
                    Ver jugador existente: {duplicate.name}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </Link>
                ) : null}
              </FormItem>
            )}
          />
        </div>

        {phoneChanged ? (
          <FormField
            control={form.control}
            name="phoneChangeReason"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Motivo del cambio de teléfono (opcional)</FormLabel>
                <FormControl>
                  <Input className="h-11 md:h-9" {...field} />
                </FormControl>
                <FormDescription>
                  El número anterior queda en el historial. El consentimiento de
                  WhatsApp otorgado para el número anterior dejará de estar
                  vigente.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Observaciones internas (opcional)</FormLabel>
              <FormControl>
                <textarea
                  rows={3}
                  className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Solo para el equipo. Nunca se envían al jugador. No registres
                aquí deudas ni pagos.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {!isEdit ? (
          <FormField
            control={form.control}
            name="whatsappConsent"
            render={({ field }) => (
              <FormItem className="rounded-lg border p-3">
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-5 shrink-0 accent-current"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    data-testid="whatsapp-consent-checkbox"
                  />
                  <span>
                    <span className="font-medium">
                      El jugador acepta recibir notificaciones por WhatsApp
                      (opcional)
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      Márcalo solo si el jugador leyó o escuchó el aviso y
                      aceptó expresamente. El teléfono es obligatorio; WhatsApp
                      no.
                    </span>
                  </span>
                </label>
                {consent ? (
                  <p
                    className="bg-muted rounded-md p-2 text-xs"
                    data-testid="consent-notice"
                  >
                    {WHATSAPP_CONSENT_NOTICE}
                    <span className="text-muted-foreground block pt-1">
                      Aviso versión {WHATSAPP_CONSENT_NOTICE_VERSION}
                    </span>
                  </p>
                ) : null}
              </FormItem>
            )}
          />
        ) : null}

        {formError ? (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        ) : null}

        <Button
          type="submit"
          className="h-11 w-full md:h-9 md:w-auto"
          disabled={submitting}
        >
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {isEdit ? "Guardar cambios" : "Registrar jugador"}
        </Button>
      </form>
    </Form>
  )
}
