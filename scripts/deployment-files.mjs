import { readdir,readFile,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Explicit allowlist: no owner credentials, setup links, local state, secrets,
// test data, dependencies, or screenshots can enter the deployment bundle.
const files=['package.json','package-lock.json','vercel.json','content.seed.json','server.mjs'];
for(const directory of ['api','lib','public']) {
  async function visit(current) {
    for(const entry of await readdir(current,{withFileTypes:true})) {
      const file=path.join(current,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile())files.push(file.replaceAll('\\','/'));
    }
  }
  await visit(directory);
}
const result=[];
for(const file of files) {
  if(file.startsWith('public/uploads/'))throw Error('Migrate local uploads explicitly before deploying.');
  const data=await readFile(file);
  result.push({file,sha:createHash('sha1').update(data).digest('hex'),size:(await stat(file)).size,data:data.toString('base64')});
}
const partIndex=process.argv.indexOf('--part');
if(partIndex>=0){const item=result.find(f=>f.file===process.argv[partIndex+1]);if(!item)throw Error('File is not in the deployment allowlist.');const offset=Number(process.argv[partIndex+2]);process.stdout.write(item.data.slice(offset,offset+8192));}
else process.stdout.write(JSON.stringify(result.map(({data,...file})=>file)));

