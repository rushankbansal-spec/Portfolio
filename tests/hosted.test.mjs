import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHostedHandler } from '../lib/hosted-api.mjs';
import { createBlobStore } from '../lib/blob-store.mjs';
import { BlobPreconditionFailedError } from '@vercel/blob';

const seed=JSON.parse(await readFile(new URL('../content.seed.json',import.meta.url),'utf8'));
const setupToken='a'.repeat(64);
function simulatedBlob() {
  let revision=0,value;
  const files=new Map();
  const get=async(name)=>{
    const bytes=name==='portfolio-private/state.json'?value:files.get(name);
    if(bytes===undefined)return null;
    const snapshot=bytes;
    return {stream:new ReadableStream({start(c){c.enqueue(Buffer.from(snapshot));c.close();}}),blob:{etag:String(revision)}};
  };
  const put=async(name,bytes,options)=>{
    if(name==='portfolio-private/state.json') {
      if(value!==undefined&&(!options.allowOverwrite||options.ifMatch!==String(revision)))throw new BlobPreconditionFailedError();
      value=String(bytes);revision++;
    } else files.set(name,Buffer.from(bytes));
  };
  return {get,put};
}
async function serve(store,secret=setupToken) {
  const server=http.createServer(createHostedHandler({store,seed,setupToken:secret,secureCookies:false}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  return {origin,close:()=>new Promise(resolve=>server.close(resolve)),async call(path,method='GET',data,cookie) {
    return fetch(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  }};
}
const sessionCookie=response=>response.headers.get('set-cookie').split(';')[0];

test('Vercel storage keeps content and owner sessions across separate function instances',async()=>{
  const backend=simulatedBlob();
  const a=await serve(createBlobStore(backend)),b=await serve(createBlobStore(backend));
  try {
    assert.equal((await a.call('/api/content','PUT',seed)).status,401);
    assert.equal((await a.call('/api/setup','POST',{token:'incorrect',password:'a-strong-owner-password'})).status,403);
    let response=await a.call('/api/setup','POST',{token:setupToken,password:'a-strong-owner-password'});
    assert.equal(response.status,200);const cookie=sessionCookie(response);
    assert.equal((await(await b.call('/api/session','GET',null,cookie)).json()).authenticated,true);
    const content=(await(await a.call('/api/content')).json()).content;
    content.profile.intro='Persisted across separate server instances.';
    assert.equal((await b.call('/api/content','PUT',content,cookie)).status,200);
    assert.equal((await(await a.call('/api/content')).json()).content.profile.intro,content.profile.intro);
    const fresh=await serve(createBlobStore(backend));
    try {
      assert.equal((await(await fresh.call('/api/content')).json()).content.profile.intro,content.profile.intro);
      assert.equal((await(await fresh.call('/api/session','GET',null,cookie)).json()).authenticated,true);
      response=await fresh.call('/api/password','POST',{current:'a-strong-owner-password',password:'a-different-long-password'},cookie);
      assert.equal(response.status,200);
      assert.equal((await(await a.call('/api/session','GET',null,cookie)).json()).authenticated,false);
      assert.equal((await b.call('/api/login','POST',{password:'a-strong-owner-password'})).status,401);
      assert.equal((await b.call('/api/login','POST',{password:'a-different-long-password'})).status,200);
    } finally {await fresh.close();}
  } finally {await a.close();await b.close();}
});

test('Vercel upload gateway exposes uploaded media but never private state',async()=>{
  const a=await serve(createBlobStore(simulatedBlob()));
  try {
    const setup=await a.call('/api/handler?route=setup','POST',{token:setupToken,password:'a-strong-owner-password'});
    const cookie=sessionCookie(setup);
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0i8AAAAASUVORK5CYII=','base64');
    let response=await fetch(a.origin+'/api/handler?route=upload',{method:'POST',headers:{Origin:a.origin,Cookie:cookie},body:bytes});
    assert.equal(response.status,200);
    const uploaded=await response.json();
    response=await a.call('/api/handler?upload='+uploaded.url.slice(9));
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.equal((await a.call('/api/handler?upload=state.json')).status,404);
    assert.equal((await a.call('/api/handler?upload=../state.json')).status,404);
    response=await fetch(a.origin+'/api/handler?route=upload',{method:'POST',headers:{Origin:a.origin,Cookie:cookie},body:Buffer.alloc(4*1024*1024+1)});
    assert.equal(response.status,413);
  } finally {await a.close();}
});

test('simultaneous initial writes and updates retry rather than losing owner or content state',async()=>{
  const backend=simulatedBlob(),a=createBlobStore(backend),b=createBlobStore(backend);
  const initial=()=>({values:[]});
  await Promise.all([a.transaction(initial,s=>s.values.push('one')),b.transaction(initial,s=>s.values.push('two'))]);
  assert.deepEqual((await a.readState()).value.values.sort(),['one','two']);
  await Promise.all([a.transaction(initial,s=>s.values.push('three')),b.transaction(initial,s=>s.values.push('four'))]);
  assert.equal((await b.readState()).value.values.length,4);
});

test('online owner setup fails closed until its private setup secret is configured',async()=>{
  const a=await serve(createBlobStore(simulatedBlob()),'');
  try {assert.equal((await a.call('/api/setup','POST',{token:setupToken,password:'a-strong-owner-password'})).status,503);}
  finally {await a.close();}
});
