import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { semanticDigest } from '../../infrastructure/json.js';

const execute = promisify(execFile);
type Runner = (args:string[]) => Promise<string>;
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const field = (value:unknown):string | null => typeof value === 'string' && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const compareCodePoints = (left:string,right:string):number => {
  const a = Array.from(left,character => character.codePointAt(0)!), b = Array.from(right,character => character.codePointAt(0)!);
  for (let index=0; index<Math.min(a.length,b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length-b.length;
};

/** Explicit, read-only CLI catalog inspection; never used for runtime source checks. */
export async function readCliCatalog(appId:string,runner:Runner = async args => {
  const result = await execute('adapty',args,{ timeout:30_000,maxBuffer:4*1024*1024,encoding:'utf8',windowsHide:true });
  return result.stdout;
}):Promise<Record<string,unknown>> {
  if (typeof appId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
    throw new Error('Invalid Adapty app ID');
  }
  let version:string;
  try { version = await runner(['--version']); } catch { throw new Error('Adapty CLI unavailable'); }
  const cliVersion = /^adapty\/[A-Za-z0-9.+_-]+/.exec(version.trim())?.[0];
  if (!cliVersion) throw new Error('Adapty CLI version unavailable');
  let page = 1,pages = 1,count:number | null = null;
  const products:Record<string,unknown>[] = [];
  while (page <= pages) {
    let payload:unknown;
    try { payload = JSON.parse(await runner(['products','list','--app',appId,'--page',String(page),'--page-size','100','--json'])); }
    catch { throw new Error('Adapty CLI catalog read failed'); }
    const pagination = record(payload) && record(payload.meta) && record(payload.meta.pagination) ? payload.meta.pagination : null;
    if (!pagination || pagination.page !== page || !Number.isInteger(pagination.pages) || Number(pagination.pages) < 1
        || Number(pagination.pages) > 20 || !Number.isInteger(pagination.count) || Number(pagination.count) < 0
        || Number(pagination.count) > 2000 || !record(payload) || !Array.isArray(payload.data)
        || (page > 1 && (pagination.pages !== pages || pagination.count !== count))) throw new Error('Adapty CLI catalog pagination invalid');
    pages = Number(pagination.pages); count = Number(pagination.count);
    for (const item of payload.data) {
      if (!record(item) || !field(item.id)) throw new Error('Adapty CLI product invalid');
      const vendors:Record<string,unknown> = {};
      if (record(item.vendor_products)) for (const store of ['app_store','play_store']) {
        const vendor = item.vendor_products[store];
        if (record(vendor)) vendors[store] = { product_id:field(vendor.product_id),base_plan_id:field(vendor.base_plan_id) };
      }
      products.push({ id:field(item.id),title:field(item.title),period:field(item.period),
        access_level_id:field(item.access_level_id),vendor_products:vendors });
    }
    page++;
  }
  if (products.length !== count || new Set(products.map(item => item.id)).size !== count) throw new Error('Adapty CLI catalog incomplete');
  products.sort((left,right) => compareCodePoints(String(left.id),String(right.id)));
  return { app_id:appId,command:'adapty products list',cli_version:cliVersion,product_count:count,
    observed_at:new Date().toISOString(),source_hash:semanticDigest(products),products };
}
