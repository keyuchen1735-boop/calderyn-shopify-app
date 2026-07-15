/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ["@remix-run/eslint-config", "@remix-run/eslint-config/node"],
  ignorePatterns: [
    "build/",
    "node_modules/",
    "public/build/",
    ".cache/",
    "*.generated.*",
  ],
  overrides: [
    {
      // Plain useNavigate drops the shop/host params embedded document
      // reloads need to re-authenticate (stale-deploy fallback → login
      // screen in the admin iframe). Use the wrapper instead.
      files: ["app/**/*.ts", "app/**/*.tsx"],
      excludedFiles: [
        "app/lib/embedded-nav.ts",
        "app/components/dashboard/DashboardApp.tsx",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@remix-run/react",
                importNames: ["useNavigate"],
                message:
                  "Use useEmbeddedNavigate from app/lib/embedded-nav so embedded shop/host params survive document reloads.",
              },
            ],
          },
        ],
      },
    },
  ],
};
