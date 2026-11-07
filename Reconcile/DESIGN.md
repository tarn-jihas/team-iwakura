# Reconcile design reference

The complete design implementation and its original design tokens are in `dist/styles.css`. The `:root` custom properties contain the named color and semantic tokens; the rest of the stylesheet is also part of the design specification, including component states, spacing, sizing, typography and responsive rules. Some values are defined directly in component rules rather than as named tokens.

- Primary typeface: Inter. Manrope is also bundled. Font files and their SIL Open Font Licenses are in `dist/fonts/`.
- The interface markup is in `dist/index.html`; application views, components and interactions are implemented in `dist/app.js`.
- Icons and other visual elements are implemented in the source where used. The bundled data in `dist/data/` is synthetic example content.
- This is the original static browser prototype. `dist/` is the project's editable source and served site, not a generated HTML snapshot. No separate design file was present in the source repository.

See `README.md` for scope, execution and tests. The source corresponds to commit `8aa33d5e320650fff3f7e7f352621aa53a75128f`, Site version 3.
