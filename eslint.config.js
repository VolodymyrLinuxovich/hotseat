import js from "@eslint/js";
import globals from "globals";

// Style rules the codebase follows by hand: every if gets braces with its body
// on its own line, and one statement per line.
const styleRules = {
  curly: ["error", "all"],
  "brace-style": ["error", "1tbs", { allowSingleLine: false }],
  "max-statements-per-line": ["error", { max: 1 }],
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
  eqeqeq: ["error", "always"],
  "prefer-const": "error",
  "no-var": "error",
};

export default [
  {
    ignores: ["dist/**", "actor/node_modules/**", "actor/storage/**", "native/**", ".tools/**", ".venv/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: styleRules,
  },
  {
    files: ["engine/**/*.js", "server.js", "api/**/*.js", "scripts/**/*.js", "tests/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: styleRules,
  },
];
