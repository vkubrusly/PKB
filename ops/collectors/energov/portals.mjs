// EnerGov county portals, shared by collect.mjs and discover.mjs.
// One entry per county portal. `base` is the CSS app root (the part before "#/").
export const PORTALS = {
  marion: {
    base: 'https://selfservice.marionfl.org/energov_prod/selfservice',
    permitPattern: /^(BLDR|BLDC|BLD|CONTRACTOR)-?\d{2}-\d{2}-\d+$|^\d{10}$/i,
  },
  // City of Winter Park (inside Orange County; the spreadsheet files these under "Orange").
  winterpark: {
    base: 'https://selfservice.cityofwinterpark.org/energov_prod/selfservice',
    permitPattern: /^[A-Z]{2,4}-\d{4}-\d+$/i,
  },
};
