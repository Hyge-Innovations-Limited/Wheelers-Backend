/**
 * What Paystack charges US per transfer, taken from the Paystack balance on
 * top of the amount sent. Published schedule (NGN): up to 5,000 → 10;
 * 5,001–50,000 → 25; above 50,000 → 50. When the provider reports the real
 * fee on a transfer, that figure wins over this table.
 */
export function transferFeeNgn(amountNgn: number): number {
  if (amountNgn <= 5_000) return 10;
  if (amountNgn <= 50_000) return 25;
  return 50;
}
