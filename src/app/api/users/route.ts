import { withApiHandler } from "@/lib/api-handler"
import { ok } from "@/lib/api-response"
import { parseJsonBody, parseQueryParams } from "@/lib/validation"
import { PERMISSIONS, requirePermission } from "@/config/permissions"
import { createUser, listUsers } from "@/modules/users/user.service"
import {
  createUserSchema,
  listUsersQuerySchema,
} from "@/modules/users/user.schemas"

export const dynamic = "force-dynamic"

/** GET /api/users — lista con búsqueda (`q`) y filtros (`role`, `status`). Solo SUPERADMIN. */
export const GET = withApiHandler(async (req, { requestId }) => {
  await requirePermission(PERMISSIONS.USERS_READ, {
    requestId,
    resource: "GET /api/users",
  })
  const query = parseQueryParams(req.nextUrl.searchParams, listUsersQuerySchema)

  return ok(await listUsers(query), { requestId })
})

/**
 * POST /api/users — alta con credencial temporal (se devuelve una sola
 * vez). Asignar un rol exige además roles:manage.
 */
export const POST = withApiHandler(async (req, { requestId }) => {
  const ctx = { requestId, resource: "POST /api/users" }
  const actor = await requirePermission(PERMISSIONS.USERS_CREATE, ctx)
  await requirePermission(PERMISSIONS.ROLES_MANAGE, ctx)
  const input = await parseJsonBody(req, createUserSchema)

  const result = await createUser(actor, input, { requestId })
  const response = ok(result, {
    status: 201,
    message: "Usuario creado",
    requestId,
  })
  response.headers.set("Cache-Control", "no-store")
  return response
})
