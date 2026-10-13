import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // cacheComponents/partialPrefetching (nuevos en Next 16) exigen anotar
  // explícitamente qué se cachea vs. qué es dinámico, e son incompatibles
  // con `export const dynamic` en Route Handlers (p. ej. los health
  // checks). Esta app es dinámica por naturaleza (auth, caja en tiempo
  // real) — se desactivan para mantener el modelo de renderizado simple,
  // como pide el Módulo 00. Puede reconsiderarse si un módulo futuro
  // necesita cachear vistas específicas.
  // Atajo en español: /configuracion/* → /dashboard/configuracion/*. Las
  // páginas privadas viven bajo /dashboard (protegido por src/proxy.ts).
  async redirects() {
    return [
      {
        source: "/configuracion/:path*",
        destination: "/dashboard/configuracion/:path*",
        permanent: false,
      },
    ]
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
}

export default nextConfig
