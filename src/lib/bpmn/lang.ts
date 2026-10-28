export type Lang = "vi" | "en";

export function asLang(value: unknown): Lang {
  return value === "en" ? "en" : "vi";
}
