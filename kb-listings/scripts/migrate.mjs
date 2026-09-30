#!/usr/bin/env node
// Apply db/schema.sql (idempotent) to the Kubrusly Basso Supabase project.
import { readFileSync } from 'node:fs';
import { sql } from '../lib/db.mjs';

await sql(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const t = await sql(`select table_name from information_schema.tables where table_schema = 'kb' order by 1`);
console.log('schema kb:', t.map((r) => r.table_name).join(', '));
