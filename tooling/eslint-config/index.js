// Shared eslint flat config for jellyfin-tv-shell packages.
// Consumed via: import config from "@jellyfin-tv/eslint-config";

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Plugin-compat first: forbid bundling jellyfin-web in any shell package.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["jellyfin-web", "jellyfin-web/*"],
              message:
                "The shell must not vendor jellyfin-web. Load it from ${server}/web/ at runtime.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/build/**", "**/node_modules/**"],
  },
];
