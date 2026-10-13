import { NextResponse } from "next/server"

import type { AppError, ErrorCode } from "@/lib/errors"

export type ApiSuccess<T> = {
  success: true
  data: T
  message?: string
  requestId: string
}

export type ApiFailure = {
  success: false
  error: {
    code: ErrorCode
    message: string
    details?: unknown
  }
  requestId: string
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export function ok<T>(
  data: T,
  init?: { message?: string; status?: number; requestId: string }
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json(
    {
      success: true,
      data,
      message: init?.message ?? "Operación realizada",
      requestId: init?.requestId ?? "unknown",
    },
    { status: init?.status ?? 200 }
  )
}

export function fail(
  error: AppError,
  requestId: string
): NextResponse<ApiFailure> {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        // Solo exponemos `details` para errores de validación/negocio —
        // nunca para INTERNAL_ERROR, que podría filtrar info interna.
        details: error.code === "INTERNAL_ERROR" ? undefined : error.details,
      },
      requestId,
    },
    { status: error.status }
  )
}
