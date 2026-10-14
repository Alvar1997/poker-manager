"use client"

import { Search } from "lucide-react"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type PlayerFilterValues = {
  q: string
  status: "all" | "active" | "inactive"
  sort: "name" | "createdAt" | "updatedAt"
}

/** Formulario GET: el estado vive en la URL y la búsqueda corre en el servidor. */
export function PlayerFilters({ values }: { values: PlayerFilterValues }) {
  return (
    <form
      method="get"
      action="/dashboard/jugadores"
      role="search"
      className="grid grid-cols-2 gap-2 md:grid-cols-[1fr_auto_auto_auto]"
    >
      <div className="relative col-span-2 md:col-span-1">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          name="q"
          defaultValue={values.q}
          placeholder="Nombre, apodo o teléfono"
          aria-label="Buscar jugadores"
          className="h-11 pl-9 md:h-9"
          enterKeyHint="search"
        />
      </div>
      <NativeSelect
        name="status"
        defaultValue={values.status}
        aria-label="Filtrar por estado"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="all">Todos</option>
        <option value="active">Activos</option>
        <option value="inactive">Inactivos</option>
      </NativeSelect>
      <NativeSelect
        name="sort"
        defaultValue={values.sort}
        aria-label="Ordenar"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="name">Nombre (A–Z)</option>
        <option value="createdAt">Más recientes</option>
        <option value="updatedAt">Actualizados</option>
      </NativeSelect>
      <Button
        type="submit"
        variant="secondary"
        className="col-span-2 h-11 md:col-span-1 md:h-9"
      >
        Buscar
      </Button>
    </form>
  )
}
