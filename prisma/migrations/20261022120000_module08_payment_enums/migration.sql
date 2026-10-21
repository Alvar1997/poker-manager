-- Módulo 08 (1/2): valores nuevos de enums. Van en una migración aparte
-- porque PostgreSQL no permite usar un valor de enum en la misma
-- transacción en que se agrega (los CHECK del paso 2 los usan).
-- Aditiva: no modifica datos existentes.

-- Tarjeta de débito y de crédito cobradas en terminal física.
ALTER TYPE "PaymentMethodCode" ADD VALUE IF NOT EXISTS 'CARD_DEBIT';
ALTER TYPE "PaymentMethodCode" ADD VALUE IF NOT EXISTS 'CARD_CREDIT';

-- Cobros de terminal aprobados pendientes del depósito del adquirente.
ALTER TYPE "FinancialAccountKind" ADD VALUE IF NOT EXISTS 'CARD_TERMINAL_CLEARING';

-- Depósito de la terminal al banco (no reconoce la venta otra vez).
ALTER TYPE "CashTransactionType" ADD VALUE IF NOT EXISTS 'CARD_TERMINAL_SETTLEMENT';
