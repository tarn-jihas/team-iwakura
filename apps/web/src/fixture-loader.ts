import adapty from '../../../Reconcile/dist/data/adapty.jsonl?raw';
import clean from '../../../Reconcile/dist/data/clean.jsonl?raw';
import doubleTracking from '../../../Reconcile/dist/data/double_tracking.jsonl?raw';
import missingRefund from '../../../Reconcile/dist/data/missing_refund.jsonl?raw';
import priceUnitError from '../../../Reconcile/dist/data/price_unit_error.jsonl?raw';
import repeatedDelivery from '../../../Reconcile/dist/data/repeated_delivery.jsonl?raw';
import zeroNetTwoErrors from '../../../Reconcile/dist/data/zero_net_two_errors.jsonl?raw';
import googleOrders from '../../../Reconcile/dist/data/google_orders.json?raw';

const files: Record<string, string> = {
  'adapty.jsonl': adapty,
  'clean.jsonl': clean,
  'double_tracking.jsonl': doubleTracking,
  'missing_refund.jsonl': missingRefund,
  'price_unit_error.jsonl': priceUnitError,
  'repeated_delivery.jsonl': repeatedDelivery,
  'zero_net_two_errors.jsonl': zeroNetTwoErrors,
  'google_orders.json': googleOrders,
};

export async function loadFixture(name: string) {
  const content = files[name];
  if (content === undefined) throw new Error(`Could not load ${name}.`);
  return content;
}
