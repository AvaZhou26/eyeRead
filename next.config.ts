import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // unpdf ships a bundled pdf.js build; libsql has a native driver. Both stay Node dependencies.
  serverExternalPackages: ["unpdf", "@libsql/client", "libsql"],
};

export default nextConfig;
