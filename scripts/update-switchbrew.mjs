#!/usr/bin/env node
// Builds data/switchbrew.json — [{id, name, regions[]}] from switchbrew.org Switch 2 title list.
// Provides titleId (id) for Switch 2 games not yet in blawar/titledb.
import { mkdir, writeFile } from 'node:fs/promises';

const URL = 'https://switchbrew.org/wiki/Switch_2:_Title_list/Games';
const ID_RE = /^0[14]00[0-9a-f]{12}$/i;

async function main() {
  await mkdir('data', { recursive: true });

  console.log('Fetching switchbrew Switch 2 title list...');
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Parse <tr> rows from the wikitable
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const entries = [];

  for (const [, rowHtml] of rows) {
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(([, c]) => c.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
    if (cells.length < 2) continue;
    const id = cells[0];
    if (!ID_RE.test(id)) continue;
    const name = cells[1];
    if (!name) continue;
    const regions = cells[2] ? cells[2].split(/\s+/).filter(Boolean) : [];
    entries.push({ id: id.toLowerCase(), name, regions });
  }

  await writeFile('data/switchbrew.json', JSON.stringify(entries));
  console.log(`✓ data/switchbrew.json — ${entries.length} Switch 2 titles`);
  if (entries.length) console.log('Sample:', JSON.stringify(entries[0]));
}

main().catch(e => { console.error(e); process.exit(1); });
