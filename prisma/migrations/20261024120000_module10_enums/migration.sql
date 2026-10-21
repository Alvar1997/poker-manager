-- Módulo 10 (1/2): valores nuevos de enums (aparte: PostgreSQL no permite
-- usarlos en la misma transacción en que se agregan). Aditiva.

-- Custodia de efectivo administrativo (por custodio) y fondos no aplicados.
ALTER TYPE "FinancialAccountKind" ADD VALUE IF NOT EXISTS 'ADMIN_CASH_CUSTODY';
ALTER TYPE "FinancialAccountKind" ADD VALUE IF NOT EXISTS 'UNAPPLIED_PLAYER_FUNDS';
ALTER TYPE "FinancialAccountScope" ADD VALUE IF NOT EXISTS 'CUSTODIAN';
