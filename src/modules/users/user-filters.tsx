"use client"

import { Search } from "lucide-react"

import { NativeSelect } from "@/components/shared/native-select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ROLE_LABEL, ROLES } from "@/config/permission-matrix"
import type { ListUsersQuery } from "@/modules/users/user.schemas"

/**
 * Búsqueda y filtros como formulario GET: el estado vive en la URL
 * (compartible, funciona sin JS). Los selects envían al cambiar.
 */
export function UserFilters({ query }: { query: ListUsersQuery }) {
  return (
    <form
      method="get"
      action="/dashboard/users"
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
          defaultValue={query.q ?? ""}
          placeholder="Buscar por nombre o correo"
          aria-label="Buscar usuarios"
          className="h-11 pl-9 md:h-9"
        />
      </div>
      <NativeSelect
        name="role"
        defaultValue={query.role ?? ""}
        aria-label="Filtrar por rol"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="">Todos los roles</option>
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        name="status"
        defaultValue={query.status}
        aria-label="Filtrar por estado"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="all">Todos</option>
        <option value="active">Activos</option>
        <option value="inactive">Inactivos</option>
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
