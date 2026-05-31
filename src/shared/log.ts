/** Prefixed, filterable logging. Filter the console by "Crunchy Tools". */
const PREFIX = '%c[Crunchy Tools]';
const STYLE = 'color:#f47521;font-weight:700';

export function log(...args: unknown[]): void {
  console.log(PREFIX, STYLE, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, STYLE, ...args);
}
