import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@toast-ui/editor"],
  // SPRINT-170: @resvg/resvg-js is a native napi module (.node binding).
  // Webpack can't parse .node files; marking it as an external package
  // makes Next.js load it at runtime via Node's normal require, same
  // treatment sharp already gets internally.
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default nextConfig;
