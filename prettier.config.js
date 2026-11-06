// Prettier for the TypeScript, the build scripts and the config files: npm run format:check (in npm run
// lint) checks them, npm run format rewrites them. Set to match the hand formatting it replaced: 120
// columns, like ruff.toml, single quotes, and a wrapped line starting with its operator (&&, ||, ??).
// Everything else is Prettier's default. Packs, schemas and lockfiles are left alone (.prettierignore).
/** @type {import('prettier').Config} */
export default {
  printWidth: 120,
  singleQuote: true,
  experimentalOperatorPosition: 'start',
};
