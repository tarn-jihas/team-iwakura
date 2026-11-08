import { readCliCatalog } from './modules/source/cli-catalog.js';

const appId = process.argv[2];
if (!appId || process.argv.length !== 3) {
  process.stderr.write('Usage: node cli-catalog-main.js <app-id>\n');
  process.exitCode = 1;
} else {
  void readCliCatalog(appId).then(result => { process.stdout.write(`${JSON.stringify(result,null,2)}\n`); },() => {
    process.stderr.write('Adapty CLI catalog inspection failed\n'); process.exitCode = 1;
  });
}
