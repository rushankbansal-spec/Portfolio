import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateContent } from '../server.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const MAX_UPLOAD = 4 * 1024 * 1024;
const mime = {png:'image/png',jpg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf'};
class ApiError extends Error { constructor(status,message) { super(message); this.status=status; } }
function fileType(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'jpg';
  if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP')return 'webp';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'gif';
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'pdf';
  throw new ApiError(415,'Choose a PNG, JPG, WebP, GIF, or PDF file.');
}
async function body(req,max) {
  if(Number(req.headers['content-length']||0)>max)throw new ApiError(413,'Choose a file smaller than 4 MB.');
  if(req.body!==undefined) {
    const data=Buffer.isBuffer(req.body)?req.body:Buffer.from(typeof req.body==='string'?req.body:JSON.stringify(req.body));
    if(data.length>max)throw new ApiError(413,'The request is too large.');
    return data;
  }
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)throw new ApiError(413,'The request is too large.');parts.push(chunk);}
  return Buffer.concat(parts);
}
async function jsonInput(req) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new ApiError(415,'Expected JSON data.');
  try{return JSON.parse((await body(req,350000)).toString());}
  catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'Invalid JSON data.');}
}
function passwordInput(value) {
  if(typeof value!=='string'||value.length<12||value.length>256)throw new ApiError(400,'Choose a password with 12 to 256 characters.');
  return value;
}
function prune(state) {
  const now=Date.now();
  for(const [key,s] of Object.entries(state.sessions))if(s.expires<=now)delete state.sessions[key];
  for(const [key,a] of Object.entries(state.attempts))if(a.until<=now)delete state.attempts[key];
}
function sessionFor(state,token) {
  const session=token && state.sessions[hash(token)];
  return session && session.expires>Date.now()?session:null;
}
function requireOwner(state,token) {
  if(!state.owner || !sessionFor(state,token))throw new ApiError(401,'Sign in to edit your portfolio.');
}

// The store owns shared state and compare-and-swap. No session or content lives
// only inside a function instance, so cold starts do not lose changes or login.
export function createHostedHandler({store,seed,setupToken,secureCookies=true}) {
  const seedContent=validateContent(seed);
  const initial=()=>({schema:1,content:structuredClone(seedContent),owner:null,sessions:{},attempts:{}});
  const state=async()=>((await store.readState())?.value || initial());
  const transaction=fn=>store.transaction(initial,async value=>{prune(value);return fn(value);});
  return async function handler(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Cache-Control','no-store');
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const host=req.headers.host;
      if(!host)throw new ApiError(400,'Missing website host.');
      const url=new URL(req.url,`https://${host}`);
      const route=url.searchParams.has('route')?'/api/'+url.searchParams.get('route'):url.pathname;
      const upload=url.searchParams.get('upload') || (url.pathname.startsWith('/uploads/')?url.pathname.slice(9):null);
      if(upload!==null) {
        if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'Method not allowed.');
        // Only opaque uploaded file names are public; state, credentials, and
        // arbitrary paths in the private Blob store can never be requested.
        if(!/^[a-f0-9]{64}\.(png|jpg|webp|gif|pdf)$/.test(upload))throw new ApiError(404,'File not found.');
        const file=await store.readUpload(upload);
        if(!file)throw new ApiError(404,'File not found.');
        const type=mime[upload.split('.').pop()];
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=31536000, immutable','Content-Disposition':`inline; filename="${upload}"`});
        if(req.method==='HEAD')return res.end();
        return await pipeline(Readable.fromWeb(file.stream),res);
      }
      if(!['GET','HEAD'].includes(req.method)) {
        const origin=req.headers.origin;
        let parsed;try{parsed=origin&&new URL(origin);}catch{}
        if(!parsed||!['https:','http:'].includes(parsed.protocol)||parsed.host!==host||req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'This request must come from your website.');
      }
      const rawCookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('portfolio_session='))?.slice(18);
      const cookie=value=>res.setHeader('Set-Cookie',`portfolio_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?43200:0}${secureCookies?'; Secure':''}`);
      if(route==='/api/content'&&req.method==='GET')return json(200,{content:(await state()).content});
      if(route==='/api/session'&&req.method==='GET') {
        const current=await state();
        return json(200,{authenticated:!!sessionFor(current,rawCookie),needsSetup:!current.owner,maxUploadBytes:MAX_UPLOAD});
      }
      if(route==='/api/logout'&&req.method==='POST') {
        if(rawCookie)await transaction(s=>{delete s.sessions[hash(rawCookie)];});
        cookie('');return json(200,{ok:true});
      }
      if(['/api/setup','/api/login','/api/password'].includes(route)&&req.method==='POST') {
        const data=await jsonInput(req);
        const ip=String(req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
        const bucket=hash(ip);
        const allowed=await transaction(s=>{
          const a=s.attempts[bucket];
          if(a&&a.count>=8)return false;
          s.attempts[bucket]={count:(a?.count||0)+1,until:a?.until||Date.now()+900000};
          return true;
        });
        if(!allowed)throw new ApiError(429,'Too many attempts. Try again in 15 minutes.');
        const newSession=random();
        await transaction(async s=>{
          if(route==='/api/setup') {
            if(s.owner)throw new ApiError(409,'Your owner account is already configured.');
            if(!setupToken || setupToken.length<32)throw new ApiError(503,'Owner setup is not configured yet.');
            if(!equal(data.token,setupToken))throw new ApiError(403,'Use your private owner setup link.');
            const salt=random();
            s.owner={salt,passwordHash:(await scrypt(passwordInput(data.password),salt,64)).toString('hex')};
          } else {
            if(route==='/api/password')requireOwner(s,rawCookie);
            const supplied=route==='/api/password'?data.current:data.password;
            if(!s.owner||typeof supplied!=='string'||supplied.length>256)throw new ApiError(401,'The password is incorrect.');
            const candidate=(await scrypt(supplied,s.owner.salt,64)).toString('hex');
            if(!equal(candidate,s.owner.passwordHash))throw new ApiError(401,'The password is incorrect.');
            if(route==='/api/password') {
              const salt=random();
              s.owner={salt,passwordHash:(await scrypt(passwordInput(data.password),salt,64)).toString('hex')};
              s.sessions={};
            }
          }
          // Bound session growth for the single owner.
          const keys=Object.keys(s.sessions);
          if(keys.length>=20)delete s.sessions[keys.sort((a,b)=>s.sessions[a].expires-s.sessions[b].expires)[0]];
          s.sessions[hash(newSession)]={expires:Date.now()+43200000};
        });
        cookie(newSession);return json(200,{ok:true});
      }
      if(route==='/api/content'&&req.method==='PUT') {
        const next=validateContent(await jsonInput(req));
        await transaction(s=>{requireOwner(s,rawCookie);s.content=next;});
        return json(200,{ok:true,content:next});
      }
      if(route==='/api/upload'&&req.method==='POST') {
        requireOwner(await state(),rawCookie);
        const bytes=await body(req,MAX_UPLOAD),ext=fileType(bytes),name=random()+'.'+ext;
        await store.writeUpload(name,bytes,mime[ext]);
        return json(200,{url:'/uploads/'+name,type:ext});
      }
      throw new ApiError(404,'This endpoint does not exist.');
    } catch(error) {
      if(res.headersSent){res.destroy();return;}
      return json(error.status||503,{error:error.status?error.message:'The editor storage is temporarily unavailable. Please try again.'});
    }
  };
}
