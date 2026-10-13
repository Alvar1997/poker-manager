import "server-only"

import { maskLast4 } from "@/lib/clabe"
import { encryptSecret } from "@/lib/crypto"
import { NotFoundError } from "@/lib/errors"
import { prisma } from "@/lib/prisma"
import {
  AUDIT_ACTIONS,
  diffChanges,
  recordAudit,
} from "@/modules/audit/audit.service"
import type { RequestContext, SessionUser } from "@/modules/auth/auth.service"
import type { UpdateBankAccountInput } from "@/modules/settings/settings.schemas"

/**
 * Cuenta bancaria receptora ÚNICA (BANK-01/02/04/10).
 *
 * - Una sola cuenta activa y principal: índice único parcial en BD.
 * - Número de cuenta y CLABE se guardan cifrados (AES-256-GCM, clave en
 *   SETTINGS_ENCRYPTION_KEY) y la API SOLO devuelve los últimos 4 dígitos
 *   (BANK-07/08). Nunca se guardan contraseñas, claves de banca ni tokens
 *   (BANK-06).
 * - Cambiar el número o la CLABE de una cuenta que ya tenía datos NO
 *   sobrescribe: crea una cuenta nueva principal y desactiva la anterior
 *   en la misma transacción, para que los movimientos futuros sigan
 *   apuntando a la cuenta correcta (BANK-09).
 * - Puede quedar sin datos (pendiente de captura): no se inventan datos.
 */

export type BankAccountView = {
  id: string
  name: string
  bankName: string | null
  accountHolder: string | null
  accountNumberMasked: string | null
  clabeMasked: string | null
  /** false mientras no se capture número de cuenta ni CLABE. */
  isConfigured: boolean
  isActive: boolean
  isPrimary: boolean
  updatedAt: string
  updatedBy: { id: string; name: string } | null
  previousAccounts: number
}

const select = {
  id: true,
  name: true,
  bankName: true,
  accountHolder: true,
  accountNumberLast4: true,
  clabeLast4: true,
  accountNumberEncrypted: true,
  clabeEncrypted: true,
  isActive: true,
  isPrimary: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const

async function findPrimary() {
  return prisma.paymentAccount.findFirst({
    where: { isPrimary: true, isActive: true },
    select,
  })
}

export async function getBankAccount(): Promise<BankAccountView> {
  const account = await findPrimary()
  if (!account) {
    throw new NotFoundError(
      "No hay cuenta bancaria principal. Ejecuta `npm run db:seed` (idempotente)."
    )
  }
  const previousAccounts = await prisma.paymentAccount.count({
    where: { isPrimary: false },
  })
  return toView(account, previousAccounts)
}

function toView(
  account: NonNullable<Awaited<ReturnType<typeof findPrimary>>>,
  previousAccounts: number
): BankAccountView {
  return {
    id: account.id,
    name: account.name,
    bankName: account.bankName,
    accountHolder: account.accountHolder,
    accountNumberMasked: maskLast4(account.accountNumberLast4),
    clabeMasked: maskLast4(account.clabeLast4),
    isConfigured: Boolean(
      account.accountNumberEncrypted || account.clabeEncrypted
    ),
    isActive: account.isActive,
    isPrimary: account.isPrimary,
    updatedAt: account.updatedAt.toISOString(),
    updatedBy: account.updatedBy,
    previousAccounts,
  }
}

export async function updateBankAccount(
  actor: SessionUser,
  input: UpdateBankAccountInput,
  ctx: RequestContext = {}
): Promise<BankAccountView> {
  // Cifrar ANTES de abrir la transacción (falla temprano si no hay clave).
  const numberData = {
    ...(input.accountNumber !== undefined
      ? {
          accountNumberEncrypted: encryptSecret(input.accountNumber),
          accountNumberLast4: input.accountNumber.slice(-4),
        }
      : {}),
    ...(input.clabe !== undefined
      ? {
          clabeEncrypted: encryptSecret(input.clabe),
          clabeLast4: input.clabe.slice(-4),
        }
      : {}),
  }
  const changesNumbers = Object.keys(numberData).length > 0
  const textData = {
    name: input.name,
    bankName: input.bankName,
    accountHolder: input.accountHolder,
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.paymentAccount.findFirst({
      where: { isPrimary: true, isActive: true },
      select,
    })
    if (!current) throw new NotFoundError("No hay cuenta bancaria principal")

    const hadNumbers = Boolean(
      current.accountNumberEncrypted || current.clabeEncrypted
    )
    // Metadatos de auditoría: SOLO últimos 4 dígitos, nunca el número.
    const maskedAfter = {
      accountNumber: maskLast4(
        numberData.accountNumberLast4 ?? current.accountNumberLast4
      ),
      clabe: maskLast4(numberData.clabeLast4 ?? current.clabeLast4),
    }

    if (changesNumbers && hadNumbers) {
      await tx.paymentAccount.update({
        where: { id: current.id },
        data: { isActive: false, isPrimary: false, updatedById: actor.id },
      })
      const replacement = await tx.paymentAccount.create({
        data: {
          name: input.name ?? current.name,
          bankName:
            input.bankName !== undefined ? input.bankName : current.bankName,
          accountHolder:
            input.accountHolder !== undefined
              ? input.accountHolder
              : current.accountHolder,
          accountNumberEncrypted: current.accountNumberEncrypted,
          accountNumberLast4: current.accountNumberLast4,
          clabeEncrypted: current.clabeEncrypted,
          clabeLast4: current.clabeLast4,
          ...numberData,
          isPrimary: true,
          isActive: true,
          createdById: actor.id,
          updatedById: actor.id,
        },
      })
      await recordAudit(
        {
          action: AUDIT_ACTIONS.BANK_ACCOUNT_REPLACED,
          entityType: "PaymentAccount",
          entityId: replacement.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            previousAccountId: current.id,
            before: {
              accountNumber: maskLast4(current.accountNumberLast4),
              clabe: maskLast4(current.clabeLast4),
            },
            after: maskedAfter,
          },
        },
        tx
      )
      return
    }

    await tx.paymentAccount.update({
      where: { id: current.id },
      data: { ...textData, ...numberData, updatedById: actor.id },
    })
    const changes = diffChanges(current, textData)
    if (changes || changesNumbers) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.BANK_ACCOUNT_UPDATED,
          entityType: "PaymentAccount",
          entityId: current.id,
          actorUserId: actor.id,
          requestId: ctx.requestId,
          metadata: {
            changes: changes ?? {},
            ...(changesNumbers ? { numbersCaptured: maskedAfter } : {}),
          },
        },
        tx
      )
    }
  })

  return getBankAccount()
}
