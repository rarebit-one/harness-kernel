import js from "@eslint/js"
import tseslint from "typescript-eslint"
import vitest from "@vitest/eslint-plugin"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      // Worktrees hold a second copy of src/ outside any tsconfig project, so
      // the type-aware parser would error on every file in them.
      ".worktrees/**",
      "eslint.config.mjs",
    ],
  },

  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A library never owns the host's stdout: everything observable goes
      // through the caller-supplied `log` callbacks on the agent/engine seams.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Test files (Vitest)
  {
    files: ["src/**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      // Test doubles implement async Provider/Tool/Engine interfaces without
      // needing to await anything.
      "@typescript-eslint/require-await": "off",
    },
  },

  prettier,
)
