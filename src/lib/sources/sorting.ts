// Sorting Hub export: storage sorting-hub/sorting/<hub>/latest.json + version.txt (public bucket).
import { normalizeCode } from '../locationRules';

/** [name, barcode, pasillo, estante, nivel, col6, temp] */
export type SortingItem = [string, string, string, string, string, string, string];

export interface SortingFile {
  hub: string;
  updatedAt: string;
  sourceFile?: string;
  count?: number;
  items: SortingItem[];
}

export interface SortingSummary {
  rows: number;
  fullPosition: number; // pasillo + estante
  aisleOnly: number; // pasillo, no estante
  noPosition: number; // no pasillo
  codeCounts: Map<string, number>; // normalized pasillo code → rows
}

function base(): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/sorting-hub/sorting`;
}

/** Cheap change check: the version string changes whenever latest.json is replaced. */
export async function fetchSortingVersion(hub: string): Promise<string> {
  const res = await fetch(`${base()}/${encodeURIComponent(hub)}/version.txt`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`version.txt ${res.status}`);
  return (await res.text()).trim();
}

export async function fetchSorting(hub: string): Promise<SortingFile> {
  const res = await fetch(`${base()}/${encodeURIComponent(hub)}/latest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`latest.json ${res.status}`);
  return (await res.json()) as SortingFile;
}

const filled = (v: unknown) => String(v ?? '').trim() !== '';

export function summarizeSorting(file: Pick<SortingFile, 'items'>): SortingSummary {
  const s: SortingSummary = { rows: 0, fullPosition: 0, aisleOnly: 0, noPosition: 0, codeCounts: new Map() };
  for (const it of file.items) {
    s.rows++;
    const [, , pasillo, estante] = it;
    if (!filled(pasillo)) {
      s.noPosition++;
      continue;
    }
    if (filled(estante)) s.fullPosition++;
    else s.aisleOnly++;
    const code = normalizeCode(pasillo);
    s.codeCounts.set(code, (s.codeCounts.get(code) ?? 0) + 1);
  }
  return s;
}
