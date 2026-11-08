import test from 'node:test';
import assert from 'node:assert/strict';
import { readCliCatalog } from '../dist/modules/source/cli-catalog.js';

test('CLI inspection reads complete pages and exposes only safe catalog fields', async () => {
  const calls = [], appId = '46a573aa-8c90-4b4b-ba72-2349ae9fb030';
  const runner = async args => {
    calls.push(args);
    if (args[0] === '--version') return 'adapty/1.2.3';
    const page = Number(args[args.indexOf('--page')+1]);
    return JSON.stringify({ meta:{ pagination:{ page,pages:2,count:2 } },data:[{ id:`product-${page}`,
      title:'Premium',period:'P1M',access_level_id:'premium',secret:'must-not-appear',
      vendor_products:{ app_store:{ product_id:`vendor-${page}`,base_plan_id:null,token:'secret' } } }] });
  };
  const catalog = await readCliCatalog(appId,runner);
  assert.equal(catalog.product_count,2);
  assert.equal(calls.length,3);
  assert.equal(JSON.stringify(catalog).includes('secret'),false);
  await assert.rejects(readCliCatalog('invalid',runner), /Invalid/);
  await assert.rejects(readCliCatalog(appId,async args => args[0] === '--version' ? 'adapty/1.0.0' :
    JSON.stringify({ meta:{ pagination:{ page:1,pages:1,count:2 } },data:[] })), /incomplete/);
});
