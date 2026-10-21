-- Módulo 12 — valores nuevos de enums existentes (migración aparte: un
-- valor agregado con ADD VALUE no puede usarse en la misma transacción).

-- Diferencia de un arqueo de CIERRE sustituida por un recuento físico o por
-- el regreso auditado a OPEN. No es un ajuste: el arqueo se conserva.
ALTER TYPE "ChipReconciliationStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
ALTER TYPE "CashDifferenceStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
