#!/usr/bin/env node
// lead_find.mjs — READ-ONLY: look up Buildertrend Lead Opportunities by title (or parcel) and print their ids.
//   BT_COOKIES_FILE=… node collectors/buildertrend/lead_find.mjs "<title or parcel>" ["<another>"…]
import { openBuildertrend } from './session.mjs';
import { findLead, leadTitle } from './lead.mjs';

const { browser, page, loggedIn } = await openBuildertrend();
if (!loggedIn) { console.error('session expired'); await browser.close(); process.exit(1); }
for (const k of process.argv.slice(2)) console.log(`${k} → ${JSON.stringify(await findLead(page, leadTitle(k)).catch((e) => e.message))}`);
await browser.close();
