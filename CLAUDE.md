# inventario-conf

Confirmación de inventario: generates and tracks each micro hub's 4-week confirmation plan.
Spec: `docs/inventarioConf-v1-plan.md`. Current phase: `docs/inventarioConf-phase0-setup.md`.

## Stack
- Vite + vanilla TypeScript, no framework. Vitest for tests (`npm test`).
- Supabase project `armado-ch` (ref `uuqqtksxlgkztenojufm`). Tables prefixed `ic_`.
  Schema changes only via `supabase/migrations/*.sql`, never dashboard edits.
- Netlify: build `npm run build`, publish `dist`.
- `src/generator/` must stay pure (no I/O) and deterministic.
- Dates always via `src/lib/time.ts` (America/Monterrey, server "now").

## Git
- Commit locally; never push. Jose pushes from GitHub Desktop.
- Never commit secrets (`.env*`, `INGEST_SECRET`, `IC_ADMIN_PIN`).

## Visual design
- Calii theme: white + teal `#00C3B3`, Plus Jakarta Sans. `src/styles/calii-theme.css` is the
  theme (don't edit); app rules go in `src/styles/app.css` using `--c-*` tokens.
- No other hues, no gradients, no emoji, no ALL-CAPS or monospace. One loud teal element per view.
- Text on teal is ink; teal text on white uses `--c-teal-dark`. Key values never wrap.
- UI in Spanish. Hub picker on every load; no remembered state.
