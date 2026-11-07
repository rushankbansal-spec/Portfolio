import { readdir,readFile,stat } from 'node:fs/promises';
import path from 'node:path';

// Explicit public source allowlist. Never collect local account data or envs.
const files=['README.md','.gitignore','.vercelignore','package.json','package-lock.json','vercel.json','content.seed.json','server.mjs'];
for(const directory of ['api','lib','public','scripts','tests','docs']) {
  async function visit(current) {
    for(const entry of await readdir(current,{withFileTypes:true})) {
      const file=path.join(current,entry.name).replaceAll('\\','/');
      if(file==='public/uploads')continue;
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile())files.push(file);
    }
  }
  await visit(directory);
}
const part=process.argv.indexOf('--part');
if(part>=0) {
  const name=process.argv[part+1];
  if(!files.includes(name))throw Error('File is not in the public source allowlist.');
  const offset=Number(process.argv[part+2]);
  process.stdout.write((await readFile(name)).toString('base64').slice(offset,offset+8192));
} else {
  const manifest=[];
  for(const file of files)manifest.push({file,size:(await stat(file)).size});
  process.stdout.write(JSON.stringify(manifest));
}
