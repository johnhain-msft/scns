import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // `npm run lint` is `eslint .`, so coverage is the default and every
    // exclusion below has to earn its place.
    //
    // dashboard/ is a separate Next.js project that lints itself — it ships its
    // own `lint` script and eslint.config.mjs. Linting it from here would apply
    // the wrong config rather than add coverage.
    ignores: [
      "dist/",
      "coverage/",
      "references/",
      "node_modules/",
      "dashboard/",
      // Ephemeral scratch from .gitignore. These hold no tracked source, so
      // skipping them costs no coverage — but `.copilot-scratch/` does hold
      // stray .ts probes, and linting it makes `npm run lint` fail locally on
      // files that are explicitly "never source of truth". `.test-*` /
      // `test-vault-*` are the #57 crashed-test-run backstop: same reasoning,
      // applied before a crash leaves one behind.
      ".copilot-scratch/",
      ".test-*/",
      "test-vault-*/",
    ],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
    },
  },
  {
    // scripts/ is the repo's command-line surface: its entire job is to print
    // to a terminal. The house rule (Pino structured logging, no console) is an
    // application-code rule and stays enforced under src/. Without this
    // exemption widening lint scope reports hundreds of no-console warnings
    // here and buries the real errors the wider scope exists to surface.
    files: ["scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
);
