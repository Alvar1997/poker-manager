import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // ExcelJS (exportación XLSX del Módulo 14) se carga desde node_modules en
  // el servidor, sin empaquetar.
  serverExternalPackages: ["exceljs"],
  // Actualizaciones asistidas de Next.js: solo parches de seguridad.
  experimental: {
    agentUpgrade: "security",
  },
  // cacheComponents/partialPrefetching (nuevos en Next 16) exigen anotar
  // explícitamente qué se cachea vs. qué es dinámico, e son incompatibles
  // con `export const dynamic` en Route Handlers (p. ej. los health
  // checks). Esta app es dinámica por naturaleza (auth, caja en tiempo
  // real) — se desactivan para mantener el modelo de renderizado simple,
  // como pide el Módulo 00. Puede reconsiderarse si un módulo futuro
  // necesita cachear vistas específicas.
  // Atajos en español: /configuracion/*, /jugadores/*, /inventario/*, /caja/*, /sesiones/* y /compras/* → /dashboard/… Las
  // páginas privadas viven bajo /dashboard (protegido por src/proxy.ts).
  async redirects() {
    return [
      {
        source: "/configuracion/:path*",
        destination: "/dashboard/configuracion/:path*",
        permanent: false,
      },
      {
        source: "/jugadores/:path*",
        destination: "/dashboard/jugadores/:path*",
        permanent: false,
      },
      {
        source: "/inventario/:path*",
        destination: "/dashboard/inventario/:path*",
        permanent: false,
      },
      {
        source: "/caja/:path*",
        destination: "/dashboard/caja/:path*",
        permanent: false,
      },
      {
        source: "/sesiones/:path*",
        destination: "/dashboard/sesiones/:path*",
        permanent: false,
      },
      {
        source: "/creditos/:path*",
        destination: "/dashboard/creditos/:path*",
        permanent: false,
      },
      {
        source: "/administracion/:path*",
        destination: "/dashboard/administracion/:path*",
        permanent: false,
      },
      {
        source: "/reportes/:path*",
        destination: "/dashboard/reportes/:path*",
        permanent: false,
      },
      {
        source: "/compras/:path*",
        destination: "/dashboard/compras/:path*",
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
