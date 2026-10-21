-- Módulo 15 — valores nuevos de FolioDocumentType (en migración aparte para
-- poder usarlos en la siguiente: folios COR- e INC-).
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'CORRECTION';
ALTER TYPE "FolioDocumentType" ADD VALUE IF NOT EXISTS 'INCIDENT';
