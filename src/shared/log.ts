/** Prefixed, filterable logging. Filter the console by "Crunchyroll Companion". */
const PREFIX = '%c[Crunchyroll Companion]';
const STYLE = 'color:#f47521;font-weight:700';

export function log(...args: unknown[]): void {
  console.log(PREFIX, STYLE, ...args);
}
