-- Mesa interactiva — valor nuevo de enum (en migración aparte para poder
-- usarlo en la siguiente): un jugador que se sienta y se retira SIN haber
-- recibido fichas termina su participación como WITHDRAWN (sin liquidación).
ALTER TYPE "ParticipationStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
