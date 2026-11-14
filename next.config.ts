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
  // unpdf ships a bundled pdf.js build that should stay a Node dependency.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
