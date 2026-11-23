/**
 * Median used by the sequencer and by AuguryHub's fraud proof. For an even count it is the
 * mean of the two middle values, truncated toward zero, exactly like Solidity's signed
 * division (BigInt division also truncates toward zero).
 */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
