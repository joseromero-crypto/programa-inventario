// Per-hub location rules (spec 4.1): first match by priority wins. Pure, no I/O.

export type LocationKind = 'shelf_aisle' | 'freezer' | 'cold_room' | 'ignore';

export interface LocationRule {
  id?: number;
  priority: number;
  match_regex: string;
  normalize_to: string | null;
  kind: LocationKind;
  group_label: string | null;
  active: boolean;
}

export interface CompiledRule extends LocationRule {
  re: RegExp;
}

export interface RuleMatch {
  unit_key: string;
  kind: LocationKind;
  rule: CompiledRule;
}

/** Codes from sorting are compared trimmed and upper-cased ('b01' and 'B01 ' are the same code). */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase();
}

export function compileRules(rules: LocationRule[]): { compiled: CompiledRule[]; errors: { rule: LocationRule; message: string }[] } {
  const compiled: CompiledRule[] = [];
  const errors: { rule: LocationRule; message: string }[] = [];
  for (const r of [...rules].filter((r) => r.active).sort((a, b) => a.priority - b.priority)) {
    try {
      compiled.push({ ...r, re: new RegExp(r.match_regex, 'u') });
    } catch (e) {
      errors.push({ rule: r, message: (e as Error).message });
    }
  }
  return { compiled, errors };
}

export function matchCode(code: string, rules: CompiledRule[]): RuleMatch | null {
  for (const rule of rules) {
    if (rule.re.test(code)) {
      const unit_key = rule.normalize_to === null ? code : code.replace(rule.re, rule.normalize_to);
      return { unit_key, kind: rule.kind, rule };
    }
  }
  return null;
}

/** Codes no rule matches, with how many sorting rows use each, most-used first. */
export function unmatchedCodes(codeCounts: Map<string, number>, rules: CompiledRule[]): { code: string; rows: number }[] {
  return [...codeCounts]
    .filter(([code]) => matchCode(code, rules) === null)
    .map(([code, rows]) => ({ code, rows }))
    .sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code));
}
