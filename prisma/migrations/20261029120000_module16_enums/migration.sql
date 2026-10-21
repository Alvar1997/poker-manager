-- Módulo 16 — valores nuevos de enums (en migración aparte para poder usarlos
-- en la siguiente: folios CAN-/REV-/AJL-/PES-, extinción por reverso de
-- compra y evidencia firmada de operaciones especiales).
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'REDEMPTION';
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'PURCHASE_REVERSAL';
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'SETTLEMENT_CORRECTION';
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'SPECIAL_PAYOUT';
ALTER TYPE "AllocationSource" ADD VALUE IF NOT EXISTS 'PURCHASE_REVERSAL';
ALTER TYPE "StoredFilePurpose" ADD VALUE IF NOT EXISTS 'SPECIAL_OPERATION_SIGNATURE';
