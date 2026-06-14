/** Prefixed, filterable logging. Filter the console by "Crunchy Companion". */
const PREFIX = '%c[Crunchy Companion]';
const STYLE = 'color:#f47521;font-weight:700';

export function log(...args: unknown[]): void {
  console.log(PREFIX, STYLE, ...args);
}
