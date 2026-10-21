-- Módulo 11 (1/2): valores nuevos de enums (aparte: PostgreSQL no permite
-- usarlos en la misma transacción en que se agregan). Aditiva: no cambia
-- ninguna participación ni archivo existente.

-- Participación que ya devolvió sus fichas y espera su pago.
ALTER TYPE "ParticipationStatus" ADD VALUE IF NOT EXISTS 'SETTLING';
-- Evidencia privada de la firma de una liquidación.
ALTER TYPE "StoredFilePurpose" ADD VALUE IF NOT EXISTS 'SETTLEMENT_SIGNATURE';
