import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**"]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "no-console": "off"
    }
  }
);
