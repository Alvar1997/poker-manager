import { vi } from "vitest"

import "@testing-library/jest-dom/vitest"

// "server-only" solo resuelve a un no-op cuando el bundler declara la
// condición "react-server" (lo hace Next.js en su build de servidor).
// Vitest no la declara, así que sin este mock cualquier módulo que lo
// importe (p. ej. src/config/permissions.ts) lanzaría al cargarse.
vi.mock("server-only", () => ({}))

// Variables de entorno mínimas para que los módulos que las validan
// (src/lib/env.ts) puedan evaluarse en tests sin depender de un .env.local
// real ni de una base Neon de verdad.
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test"
process.env.DIRECT_URL ||= "postgresql://test:test@localhost:5432/test"
process.env.AUTH_SECRET ||= "test-secret-at-least-32-characters-long"
process.env.AUTH_URL ||= "http://localhost:3000"
