-- Módulo 09: firmas de reconocimiento de crédito y comprobantes digitales.
-- Aditiva: solo crea tablas y restricciones nuevas. No inventa firmas ni
-- comprobantes para compras anteriores. Ver docs/MODULE_09_SIGNATURES_RECEIPTS.md.

-- CreateEnum
CREATE TYPE "PurchaseSignatureStatus" AS ENUM ('VALID', 'INVALIDATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StoredFileStatus" AS ENUM ('PENDING', 'ACTIVE', 'ORPHANED');

-- CreateEnum
CREATE TYPE "StoredFilePurpose" AS ENUM ('PURCHASE_SIGNATURE');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('AVAILABLE', 'VOIDED');

-- CreateTable
CREATE TABLE "signature_snapshots" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "playerNameSnapshot" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionFolioSnapshot" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "tableNameSnapshot" TEXT NOT NULL,
    "purchaseFolio" TEXT NOT NULL,
    "purchaseType" "ChipPurchaseType" NOT NULL,
    "rebuyNumber" INTEGER,
    "nominalAmount" DECIMAL(14,2) NOT NULL,
    "confirmedPaymentsAmount" DECIMAL(14,2) NOT NULL,
    "pendingTransferAmount" DECIMAL(14,2) NOT NULL,
    "outstandingCreditAmount" DECIMAL(14,2) NOT NULL,
    "paymentsSnapshot" JSONB NOT NULL,
    "creditAuthorizationId" TEXT NOT NULL,
    "authorizedByPartnerId" TEXT NOT NULL,
    "partnerNameSnapshot" TEXT NOT NULL,
    "authorizationChannel" "CreditAuthorizationChannel" NOT NULL,
    "declarationText" TEXT NOT NULL,
    "declarationVersion" TEXT NOT NULL,
    "purchaseVersion" INTEGER NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "preparedById" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,

    CONSTRAINT "signature_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_signatures" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "status" "PurchaseSignatureStatus" NOT NULL DEFAULT 'VALID',
    "signedAt" TIMESTAMP(3) NOT NULL,
    "capturedById" TEXT NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedById" TEXT,
    "invalidationReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "StoredFileStatus" NOT NULL DEFAULT 'PENDING',
    "purchaseId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),
    "orphanedAt" TIMESTAMP(3),

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_blobs" (
    "storageKey" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_blobs_pkey" PRIMARY KEY ("storageKey")
);

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "signatureId" TEXT,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'AVAILABLE',
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "voidReference" TEXT,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_snapshots_payloadHash_key" ON "signature_snapshots"("payloadHash");

-- CreateIndex
CREATE INDEX "signature_snapshots_purchaseId_preparedAt_idx" ON "signature_snapshots"("purchaseId", "preparedAt");

-- CreateIndex
CREATE UNIQUE INDEX "signature_snapshots_purchaseId_contentHash_key" ON "signature_snapshots"("purchaseId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_signatures_snapshotId_key" ON "purchase_signatures"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_signatures_fileId_key" ON "purchase_signatures"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_signatures_idempotencyKey_key" ON "purchase_signatures"("idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_signatures_purchaseId_status_idx" ON "purchase_signatures"("purchaseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storageKey_key" ON "stored_files"("storageKey");

-- CreateIndex
CREATE INDEX "stored_files_status_createdAt_idx" ON "stored_files"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_purchaseId_key" ON "purchase_receipts"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_deliveryId_key" ON "purchase_receipts"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_signatureId_key" ON "purchase_receipts"("signatureId");

-- CreateIndex
CREATE INDEX "purchase_receipts_status_idx" ON "purchase_receipts"("status");

-- AddForeignKey
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "purchase_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_authorizedByPartnerId_fkey" FOREIGN KEY ("authorizedByPartnerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "signature_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_invalidatedById_fkey" FOREIGN KEY ("invalidatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "purchase_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "purchase_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════
-- Integridad de evidencias (última defensa; los servicios validan primero)
-- ═══════════════════════════════════════════════════════════════════════

-- Snapshot: solo se firma un saldo a crédito > 0; pagos + crédito = importe.
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_amounts_valid"
  CHECK ("nominalAmount" > 0 AND "confirmedPaymentsAmount" >= 0
         AND "pendingTransferAmount" >= 0 AND "outstandingCreditAmount" > 0
         AND "pendingTransferAmount" <= "outstandingCreditAmount"
         AND "confirmedPaymentsAmount" + "outstandingCreditAmount" = "nominalAmount"
         AND "purchaseVersion" >= 1);
ALTER TABLE "signature_snapshots" ADD CONSTRAINT "signature_snapshots_numbering_valid"
  CHECK (("purchaseType" = 'INITIAL_PURCHASE' AND "rebuyNumber" IS NULL)
         OR ("purchaseType" = 'REBUY' AND "rebuyNumber" >= 1));

CREATE FUNCTION "evidence_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es evidencia inmutable (%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "signature_snapshots_immutable" BEFORE UPDATE OR DELETE ON "signature_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "evidence_append_only"();

-- Firmas: una VALID por compra; nace VALID; solo VALID → INVALIDATED/CANCELLED.
CREATE UNIQUE INDEX "purchase_signatures_one_valid"
  ON "purchase_signatures" ("purchaseId") WHERE "status" = 'VALID';
ALTER TABLE "purchase_signatures" ADD CONSTRAINT "purchase_signatures_invalidation_complete"
  CHECK (("status" = 'VALID') = ("invalidatedAt" IS NULL)
         AND ("status" = 'VALID' OR ("invalidatedById" IS NOT NULL AND "invalidationReason" IS NOT NULL)));

CREATE FUNCTION "purchase_signatures_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'VALID' THEN
      RAISE EXCEPTION 'Una firma nace VALID';
    END IF;
    -- La firma corresponde a la compra y al jugador de su snapshot.
    IF NOT EXISTS (SELECT 1 FROM "signature_snapshots" s
                   WHERE s."id" = NEW."snapshotId" AND s."purchaseId" = NEW."purchaseId"
                     AND s."playerId" = NEW."playerId") THEN
      RAISE EXCEPTION 'La firma no corresponde a la compra o al jugador del resumen';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_signatures no admite DELETE (evidencia)';
  END IF;
  IF OLD."status" <> 'VALID' OR NEW."status" NOT IN ('INVALIDATED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Una firma solo pasa de VALID a INVALIDATED o CANCELLED';
  END IF;
  IF EXISTS (SELECT 1 FROM "purchase_deliveries" d WHERE d."signatureId" = OLD."id") THEN
    RAISE EXCEPTION 'La firma de una entrega confirmada no se invalida';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'invalidatedAt', 'invalidatedById', 'invalidationReason'])
     <> (to_jsonb(OLD) - ARRAY['status', 'invalidatedAt', 'invalidatedById', 'invalidationReason']) THEN
    RAISE EXCEPTION 'La imagen, el resumen y los datos de una firma son inmutables';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_signatures_guard" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_signatures"
  FOR EACH ROW EXECUTE FUNCTION "purchase_signatures_guard"();

-- Una entrega con firma usa una firma VALID de la MISMA compra.
CREATE FUNCTION "purchase_deliveries_signature_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."signatureId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "purchase_signatures" s
    WHERE s."id" = NEW."signatureId" AND s."purchaseId" = NEW."purchaseId" AND s."status" = 'VALID'
  ) THEN
    RAISE EXCEPTION 'La entrega solo puede usar una firma VALID de la misma compra';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_deliveries_signature_check" BEFORE INSERT ON "purchase_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "purchase_deliveries_signature_check"();

-- Archivos privados: tamaño y hash obligatorios; contenido inmutable; sin DELETE.
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_valid"
  CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 1048576 AND length("sha256") = 64
         AND ("status" <> 'ACTIVE' OR "promotedAt" IS NOT NULL));
CREATE FUNCTION "stored_files_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stored_files no admite DELETE (trazabilidad)';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Un archivo ACTIVE u ORPHANED no cambia';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'purchaseId', 'promotedAt', 'orphanedAt'])
     <> (to_jsonb(OLD) - ARRAY['status', 'purchaseId', 'promotedAt', 'orphanedAt']) THEN
    RAISE EXCEPTION 'El contenido de un archivo privado es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "stored_files_guard" BEFORE UPDATE OR DELETE ON "stored_files"
  FOR EACH ROW EXECUTE FUNCTION "stored_files_guard"();

-- Contenido binario: no se sustituye; solo se borra si nunca fue evidencia.
CREATE FUNCTION "evidence_blobs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'evidence_blobs no admite UPDATE (la imagen no se sustituye)';
  END IF;
  IF EXISTS (SELECT 1 FROM "stored_files" f WHERE f."storageKey" = OLD."storageKey" AND f."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'No se borra el contenido de una evidencia ACTIVE';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "evidence_blobs_guard" BEFORE UPDATE OR DELETE ON "evidence_blobs"
  FOR EACH ROW EXECUTE FUNCTION "evidence_blobs_guard"();

-- Comprobantes: solo de compras CONFIRMED; contenido inmutable; solo AVAILABLE → VOIDED.
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_void_complete"
  CHECK (("status" = 'AVAILABLE') = ("voidedAt" IS NULL)
         AND ("status" = 'AVAILABLE' OR ("voidedById" IS NOT NULL AND "voidReason" IS NOT NULL)));
CREATE FUNCTION "purchase_receipts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AVAILABLE' OR NOT EXISTS (
      SELECT 1 FROM "chip_purchases" p WHERE p."id" = NEW."purchaseId" AND p."status" = 'CONFIRMED'
    ) THEN
      RAISE EXCEPTION 'Solo una compra CONFIRMED tiene comprobante disponible';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_receipts no admite DELETE (historial)';
  END IF;
  IF OLD."status" <> 'AVAILABLE' OR NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'Un comprobante solo pasa de AVAILABLE a VOIDED';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'voidedAt', 'voidedById', 'voidReason', 'voidReference'])
     <> (to_jsonb(OLD) - ARRAY['status', 'voidedAt', 'voidedById', 'voidReason', 'voidReference']) THEN
    RAISE EXCEPTION 'El contenido de un comprobante es inmutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_receipts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_receipts"
  FOR EACH ROW EXECUTE FUNCTION "purchase_receipts_guard"();
