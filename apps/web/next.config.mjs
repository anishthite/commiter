/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We import the workspace `ingest` package as TS source — Next needs
  // to transpile it like first-party code.
  transpilePackages: ["ingest"],
  experimental: {
    // @libsql/client and the underlying `libsql` native module are
    // Node-only. Keep them external so Next doesn't try to bundle the
    // native bindings / README / LICENSE files.
    serverComponentsExternalPackages: ["@libsql/client", "libsql"],
  },
  // Belt + suspenders: also mark them as webpack externals on the server
  // build, since transpilePackages otherwise follows them into the graph.
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [config.externals];
      externals.push({
        "@libsql/client": "commonjs @libsql/client",
        libsql: "commonjs libsql",
      });
      config.externals = externals;
    }
    // The `ingest` package uses Node-ESM-style `./foo.js` imports that
    // actually resolve to `./foo.ts` (since tsx executes the TS source).
    // Teach webpack the same rewrite so transpilePackages can follow them.
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
