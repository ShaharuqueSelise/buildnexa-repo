// Calendar days as "YYYY-MM-DD" strings, and working days (Monday to Friday). Public holidays come
// with the project calendar later. The Functions use the same rules on the server.

/** Today in the browser's timezone. */
export const todayIso = () => new Date().toLocaleDateString("en-CA");

const weekday = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
export const isWeekend = (iso: string) => weekday(iso) === 0 || weekday(iso) === 6;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Adds (or, for negative n, subtracts) working days. */
export function addWorkingDays(iso: string, n: number): string {
  let d = iso.slice(0, 10);
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d = addDays(d, step);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}

/** Working days after `from` up to and including `to` (0 when `to` is not later). */
export function workingDaysBetween(from: string, to: string): number {
  let count = 0;
  let d = from.slice(0, 10);
  const end = to.slice(0, 10);
  while (d < end) {
    d = addDays(d, 1);
    if (!isWeekend(d)) count += 1;
  }
  return count;
}
