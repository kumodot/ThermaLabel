// Self-test: the TP6-S driver must produce exactly the bytes the vendor library produces.
// Usage: node docs/selftest/selftest_tp6s.mjs
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
vm.runInThisContext(readFileSync(join(here, '../../js/drivers/tp6s.js'), 'utf8'));
const t = window.ThermaLabelDrivers.tp6s._test;

const vec = join(here, 'vectors');
const { cases } = JSON.parse(readFileSync(join(vec, 'index.json'), 'utf8'));
let fail = 0;
for (const c of cases) {
  const rgba = gunzipSync(readFileSync(join(vec, `${c.name}.rgba.gz`)));
  const want = gunzipSync(readFileSync(join(vec, `${c.name}.expected.bin.gz`)));
  t.setSequence(c.seqBefore);
  const got = t.buildTp6sPrintJob(t.rgbaToMonoRows(rgba, c.w, c.h), c.w, c.h, { density: c.density, speed: c.speed }).bytes;
  const ok = got.length === want.length && got.every((b, i) => b === want[i]);
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name} (${got.length} bytes)`);
}
console.log(fail ? `${fail} FAILED` : 'ALL MATCH');
process.exit(fail ? 1 : 0);
