export const CARRIERS = ['SingPost', 'Ninja Van', 'J&T Express', 'DHL', 'Qxpress', 'UPS', 'FedEx'] as const;

/** Guess the carrier from the tracking number's format. Returns '' when unknown. */
export function detectCarrier(raw: string): string {
  const n = (raw || '').trim().toUpperCase();
  if (!n) return '';
  if (/^NV/.test(n)) return 'Ninja Van';
  if (/^JT/.test(n)) return 'J&T Express';
  if (/^SP|^[A-Z]{2}\d{9}SG$/.test(n)) return 'SingPost';
  if (/^1Z/.test(n)) return 'UPS';
  if (/^\d{10}$/.test(n)) return 'DHL';
  if (/^\d{12}$/.test(n)) return 'FedEx';
  if (/^QX/.test(n)) return 'Qxpress';
  return '';
}

const TRACK: Record<string, (n: string) => string> = {
  'SingPost': (n) => 'https://www.singpost.com/track-items?tracknumber=' + n,
  'Ninja Van': (n) => 'https://www.ninjavan.co/en-sg/tracking?id=' + n,
  'J&T Express': (n) => 'https://www.jtexpress.sg/tracking?awb=' + n,
  'DHL': (n) => 'https://www.dhl.com/sg-en/home/tracking.html?tracking-id=' + n,
  'UPS': (n) => 'https://www.ups.com/track?tracknum=' + n,
  'FedEx': (n) => 'https://www.fedex.com/fedextrack/?trknbr=' + n,
  'Qxpress': (n) => 'https://www.qxpress.net/Tracking?trackNo=' + n,
};

export function trackUrl(carrier: string, number: string): string {
  const f = TRACK[carrier];
  return f ? f(encodeURIComponent(number)) : 'https://t.17track.net/en#nums=' + encodeURIComponent(number);
}
