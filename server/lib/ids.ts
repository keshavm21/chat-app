// server/lib/ids.ts
// Row ids (and seqs) are Postgres integers (int4, ADR 0002). A larger number would make
// Postgres fail the query ("out of range for type integer"), a 500 instead of a 404 or 400.

/** The largest id or seq: int4's maximum. */
export const MAX_ID = 2_147_483_647;

/** Whether `value` can be a row id: a positive int4. For socket payloads, which can be anything. */
export function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ID;
}

/** A path parameter as a row id, or undefined when it cannot be one (then nothing has that id). */
export function parseId(param: unknown): number | undefined {
  if (typeof param !== 'string' || !/^[1-9][0-9]{0,9}$/.test(param)) return undefined;
  const id = Number(param);
  return id <= MAX_ID ? id : undefined;
}
