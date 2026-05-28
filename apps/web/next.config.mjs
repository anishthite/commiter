/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We import the workspace `ingest` package as TS source — Next needs
  // to transpile it like first-party code.
  transpilePackages: ["ingest"],
  // TODO(next-15): rename experimental.serverComponentsExternalPackages
  //                -> top-level serverExternalPackages.
  experimental: {
    // @libsql/client and the underlying `libsql` native module are
    // Node-only. Keep them external so Next doesn't try to bundle the
    // native bindings / README / LICENSE files.
    serverComponentsExternalPackages: ["@libsql/client", "libsql"],
  },
  // The serverComponentsExternalPackages flag is NOT sufficient by itself.
  // The simplicity review (Phase 1, F2) claimed it was; empirically a
  // production build without this webpack externals push still drags
  // libsql/@libsql/hrana-client native bindings (and their README/LICENSE)
  // into the webpack graph via dynamic context requires inside
  // libsql/index.js. The externals push is what actually stops webpack
  // from trying to parse those non-JS files.
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [config.externals];
      externals.push({
        "@libsql/client": "commonjs @libsql/client",
        libsql: "commonjs libsql",
      });
      config.externals = externals;
    }
    return config;
  },
};

export default nextConfig;
