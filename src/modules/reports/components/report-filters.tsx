"use client"

import { Filter, X } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Filtros de reportes (cliente). Viven en la URL (search params): así
 * persisten al ir al detalle y volver, y se pueden compartir. Además se
 * recuerdan por pestaña (sessionStorage) para restaurarlos al regresar por
 * el menú. El servidor vuelve a validarlos siempre.
 */

export type FilterField =
  | "from"
  | "to"
  | "sessionId"
  | "tableId"
  | "playerId"
  | "method"
  | "status"
  | "operatorId"
  | "partnerId"
  | "debtFrom"
  | "debtTo"
  | "paymentFrom"
  | "paymentTo"

type Option = { id: string; label: string }

const FIELD_LABEL: Record<FilterField, string> = {
  from: "Desde",
  to: "Hasta",
  sessionId: "Sesión",
  tableId: "Mesa",
  playerId: "Jugador",
  method: "Método de pago",
  status: "Estado",
  operatorId: "Usuario operador",
  partnerId: "Socio autorizador",
  debtFrom: "Origen de deuda desde",
  debtTo: "Origen de deuda hasta",
  paymentFrom: "Fecha de abono desde",
  paymentTo: "Fecha de abono hasta",
}

const DATE_FIELDS = new Set<FilterField>([
  "from",
  "to",
  "debtFrom",
  "debtTo",
  "paymentFrom",
  "paymentTo",
])

const METHODS: Option[] = [
  { id: "CASH", label: "Efectivo" },
  { id: "BANK_TRANSFER", label: "Transferencia" },
  { id: "CARD_DEBIT", label: "Tarjeta de débito" },
  { id: "CARD_CREDIT", label: "Tarjeta de crédito" },
]

const storageKey = (path: string) => `pm-report-filters:${path}`

function readSaved(path: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(path))
  } catch {
    return null
  }
}

function save(path: string, query: string) {
  try {
    window.sessionStorage.setItem(storageKey(path), query)
  } catch {
    // Sin almacenamiento disponible: la URL sigue siendo la fuente.
  }
}

/** Restaura los últimos filtros al volver a un reporte sin parámetros. */
export function FilterMemory() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const query = params.toString()
  useEffect(() => {
    if (query) {
      save(pathname, query)
      return
    }
    const saved = readSaved(pathname)
    if (saved) router.replace(`${pathname}?${saved}`, { scroll: false })
  }, [pathname, query, router])
  return null
}

export function ReportFiltersForm({
  fields,
  statuses = [],
  options,
}: {
  fields: FilterField[]
  statuses?: Option[]
  options: {
    sessions?: Option[]
    tables?: Option[]
    players?: Option[]
    operators?: Option[]
    partners?: Option[]
  }
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const initial = () =>
    Object.fromEntries(fields.map((f) => [f, params.get(f) ?? ""])) as Record<
      FilterField,
      string
    >
  const [values, setValues] = useState(initial)
  const [open, setOpen] = useState(() => fields.some((f) => params.get(f)))
  const active = fields.filter((f) => params.get(f)).length

  const optionsFor = (f: FilterField): Option[] | null => {
    if (f === "sessionId") return options.sessions ?? []
    if (f === "tableId") return options.tables ?? []
    if (f === "playerId") return options.players ?? []
    if (f === "operatorId") return options.operators ?? []
    if (f === "partnerId") return options.partners ?? []
    if (f === "method") return METHODS
    if (f === "status") return statuses
    return null
  }

  function apply(e: FormEvent) {
    e.preventDefault()
    const next = new URLSearchParams()
    const pageSize = params.get("pageSize")
    if (pageSize) next.set("pageSize", pageSize)
    for (const f of fields) if (values[f]) next.set(f, values[f])
    const q = next.toString()
    save(pathname, q)
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false })
  }

  function clear() {
    setValues(
      Object.fromEntries(fields.map((f) => [f, ""])) as Record<
        FilterField,
        string
      >
    )
    save(pathname, "")
    router.push(pathname, { scroll: false })
  }

  return (
    <div className="rounded-lg border p-3" data-testid="report-filters">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-2 md:h-9"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="toggle-filters"
        >
          <Filter aria-hidden="true" />
          Filtros{active ? ` (${active})` : ""}
        </Button>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-2 md:h-9"
            onClick={clear}
            data-testid="clear-filters"
          >
            <X aria-hidden="true" />
            Limpiar
          </Button>
        ) : null}
      </div>
      {open ? (
        <form
          onSubmit={apply}
          className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"
        >
          {fields.map((f) => {
            const opts = optionsFor(f)
            const id = `filter-${f}`
            return (
              <div key={f} className="space-y-1">
                <Label htmlFor={id}>{FIELD_LABEL[f]}</Label>
                {DATE_FIELDS.has(f) ? (
                  <Input
                    id={id}
                    type="date"
                    value={values[f]}
                    data-testid={id}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f]: e.target.value }))
                    }
                  />
                ) : (
                  <NativeSelect
                    id={id}
                    value={values[f]}
                    data-testid={id}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f]: e.target.value }))
                    }
                  >
                    <option value="">Todos</option>
                    {(opts ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </div>
            )
          })}
          <div className="flex items-end sm:col-span-2 md:col-span-3">
            <Button
              type="submit"
              className="h-11 w-full sm:w-auto md:h-9"
              data-testid="apply-filters"
            >
              Aplicar filtros
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
