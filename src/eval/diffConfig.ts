export interface FieldDiff {
  path: string;
  /** Distinct JSON values across runs, sorted. A missing value is the string "null". */
  distinct: string[];
  byRun: Record<string, string | null>;
}

export interface ConfigDiff {
  runs: number;
  runIds: string[];
  differingFieldCount: number;
  fields: FieldDiff[];
}

/** Flatten one normalized config to path → JSON text. Array indexes stay in stored order. */
export function flattenConfig(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out.set(prefix, "[]");
    value.forEach((item, index) => {
      const path = `${prefix}[${index}]`;
      if (item && typeof item === "object") {
        for (const [key, child] of flattenConfig(item, path)) out.set(key, child);
      } else out.set(path, JSON.stringify(item));
    });
    return out;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out.set(prefix, "{}");
    for (const [key, child] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object") {
        for (const [childPath, childValue] of flattenConfig(child, path)) out.set(childPath, childValue);
      } else out.set(path, JSON.stringify(child));
    }
    return out;
  }
  if (prefix) out.set(prefix, JSON.stringify(value));
  return out;
}

/** Paths whose stored value is not the same in every run. */
export function diffNormalized(runIds: string[], configs: unknown[]): ConfigDiff {
  const flat = configs.map((config) => flattenConfig(config));
  const paths = [...new Set(flat.flatMap((map) => [...map.keys()]))].sort();
  const fields: FieldDiff[] = [];
  for (const path of paths) {
    const byRun: Record<string, string | null> = {};
    const values: string[] = [];
    runIds.forEach((id, index) => {
      const map = flat[index];
      const value = map?.has(path) ? map.get(path)! : null;
      byRun[id] = value;
      values.push(value === null ? "null" : value);
    });
    const distinct = [...new Set(values)].sort();
    if (distinct.length > 1) fields.push({ path, distinct, byRun });
  }
  return { runs: runIds.length, runIds, differingFieldCount: fields.length, fields };
}
