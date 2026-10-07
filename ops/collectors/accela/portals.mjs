// Accela Citizen Access portals, shared by collect.mjs and scripts/discover_permits.mjs.
export const PORTALS = {
  citrus: { base: 'https://aca-prod.accela.com/CITRUS', module: 'Building' },
  charlotte: { base: 'https://aca-prod.accela.com/BOCC', module: 'Building' },
  northport: { base: 'https://aca-prod.accela.com/NORTHPORT', module: 'Building', modules: ['Building', 'Planning'] },
};
