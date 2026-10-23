-- Módulo 17 — jugadores bancados por la casa (privado).
-- Valores nuevos de enums existentes en una migración propia: PostgreSQL no
-- permite USAR un valor agregado dentro de la misma transacción.

ALTER TYPE "CashTransactionType" ADD VALUE IF NOT EXISTS 'BANKING_FUNDS_RECEIVED';
ALTER TYPE "FinancialAccountKind" ADD VALUE IF NOT EXISTS 'BANKING_PLAYER_SHARE';
ALTER TYPE "SpecialPayableKind" ADD VALUE IF NOT EXISTS 'BANKING_ADVANCE';
ALTER TYPE "SpecialPayableKind" ADD VALUE IF NOT EXISTS 'BANKING_CYCLE_PAYOUT';
ALTER TYPE "SpecialPayableKind" ADD VALUE IF NOT EXISTS 'BANKING_RESERVE_WITHDRAWAL';
