// Formatting helpers. Estimates are in USD (Florida); UI copy is pt-BR.

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

export const money = (v: number | null | undefined): string =>
  v == null ? '—' : usd.format(v);

export const number = (v: number | null | undefined): string =>
  v == null ? '—' : num.format(v);

export const psf = (total: number | null | undefined, area: number | null | undefined): string =>
  total == null || !area ? '—' : usd.format(total / area);

export const SPEC_LEVEL_LABEL: Record<string, string> = {
  essential: 'Essential',
  signature: 'Signature',
  luxury: 'Luxury',
  any: 'Qualquer',
};

export const UNIT_LABEL: Record<string, string> = {
  ea: 'Un', sf: 'sf', lf: 'lf', cy: 'cy', ls: 'Verba', hr: 'h',
  gal: 'gal', sq: 'sq', ton: 'ton', bid: 'Bid', mo: 'Mês',
};

export const WATER_LABEL: Record<string, string> = {
  municipal: 'Municipal', well: 'Poço',
};
export const SEWER_LABEL: Record<string, string> = {
  municipal: 'Municipal', septic: 'Séptico', septic_nitrogen: 'Séptico (redução N)',
};
