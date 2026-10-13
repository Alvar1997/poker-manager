import { Prisma } from "@/generated/prisma/client"

/** true si el error es una violación de unicidad (P2002) de Prisma. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  )
}
