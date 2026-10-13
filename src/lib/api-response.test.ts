import { describe, expect, it } from "vitest"

import { fail, ok } from "@/lib/api-response"
import { NotFoundError, ValidationError } from "@/lib/errors"

describe("ok", () => {
  it("devuelve el formato de éxito estándar", async () => {
    const response = ok({ id: "1" }, { requestId: "req-1" })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { id: "1" },
      message: "Operación realizada",
      requestId: "req-1",
    })
  })

  it("permite status y message personalizados", async () => {
    const response = ok(
      { id: "2" },
      { requestId: "req-2", status: 201, message: "Creado" }
    )
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.message).toBe("Creado")
  })
})

describe("fail", () => {
  it("devuelve el formato de error estándar con el status del AppError", async () => {
    const response = fail(new NotFoundError("Usuario no encontrado"), "req-3")
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Usuario no encontrado",
        details: undefined,
      },
      requestId: "req-3",
    })
  })

  it("incluye `details` para errores de validación", async () => {
    const details = [{ path: "email", message: "inválido" }]
    const response = fail(
      new ValidationError("Datos inválidos", details),
      "req-4"
    )
    const body = await response.json()

    expect(body.error.details).toEqual(details)
  })

  it("nunca expone `details` en errores internos", async () => {
    const internal = new ValidationError("x")
    // Forzamos un INTERNAL_ERROR con detalles sensibles para confirmar que se descartan.
    Object.assign(internal, {
      code: "INTERNAL_ERROR",
      status: 500,
      details: { stack: "secret" },
    })

    const response = fail(internal, "req-5")
    const body = await response.json()

    expect(body.error.details).toBeUndefined()
  })
})
