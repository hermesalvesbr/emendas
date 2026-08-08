import type { Config } from "./types.ts";

let cached: Config | undefined;

export async function loadConfig(path = "config.yaml"): Promise<Config> {
  if (cached) return cached;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`config.yaml não encontrado em ${path}`);
  }

  const text = await file.text();
  const parsed = Bun.YAML.parse(text) as Config;

  cached = {
    startYear: parsed.startYear,
    pentaho: { ...parsed.pentaho },
    ckan: { ...parsed.ckan },
    retry: { ...parsed.retry },
    watch: { ...parsed.watch },
    http: { ...parsed.http },
    server: { ...parsed.server },
  } satisfies Config;

  return cached;
}
