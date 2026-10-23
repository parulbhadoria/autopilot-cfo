const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 9800 -> "$98.00". */
export const usd = (cents?: number): string => (cents === undefined ? "n/a" : money.format(cents / 100));

/** Cents -> the text shown in a dollar input, e.g. 10000 -> "100.00". */
export const dollarsInput = (cents: number): string => (cents / 100).toFixed(2);

/** "$1,250.50" or "75" -> integer cents, or null when the text is not a positive amount. */
export function parseDollars(input: string): number | null {
  const t = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(parseFloat(t) * 100);
  return cents > 0 ? cents : null;
}