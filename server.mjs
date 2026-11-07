import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const base = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.pdf':'application/pdf','.json':'application/json'};
class HttpError extends Error { constructor(status,message) {super(message);this.status=status;} }
const defaultStory = [
  {id:'experiment',label:'The experiment',title:'Follow the\nsignal.',body:'A sensor reading. A sentence. A hand gesture. I collect the inputs, train a model, and test what it can do.',proof:'PrecipyTech / Fact-Checker / Gesture Recognition'},
  {id:'system',label:'The system',title:'Make it\nwork.',body:'A model becomes a tool when the pieces connect. I build the backend, connect the interface, and turn the experiment into something you can use.',proof:'Browser extensions / Developer tools / Web applications'}
];
export function validateContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400,'Invalid portfolio data.');
  value={...value,story:value.story??defaultStory};
  const text=(v,max=5000)=>{if(typeof v!=='string'||v.length>max) throw new HttpError(400,'A field is missing or too long.');return v;};
  const url=(v,asset=false)=>{text(v,2048);if(!v)return v;if(asset&&/^\/(art|uploads)\/[a-zA-Z0-9._-]+$/.test(v)||asset&&v==='/resume.pdf')return v;try{const u=new URL(v);if(u.protocol==='https:')return v;}catch{}throw new HttpError(400,'Use a valid HTTPS link or an uploaded file.');};
  const strings=(v)=>{if(!Array.isArray(v)||v.length>50)throw new HttpError(400,'Too many list items.');return v.map(x=>text(x,1000));};
  const rows=(key,fn)=>{const a=value[key];if(!Array.isArray(a)||a.length>60)throw new HttpError(400,'Invalid content list.');if(key==='story'&&a.length!==2)throw new HttpError(400,'The scroll story needs two chapters after your introduction.');const seen=new Set();return a.map(x=>{if(!x||typeof x!=='object')throw new HttpError(400,'Invalid item.');const id=text(x.id,80);if(!/^[a-zA-Z0-9_-]+$/.test(id)||seen.has(id))throw new HttpError(400,'Invalid or duplicate item ID.');seen.add(id);return {id,...fn(x)};});};
  const p=value.profile,e=value.education;
  if(!p||!e)throw new HttpError(400,'Profile and education are required.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))throw new HttpError(400,'Enter a valid email address.');
  return {story:rows('story',x=>({label:text(x.label,100),title:text(x.title,160),body:text(x.body,600),proof:text(x.proof,300)})),profile:{name:text(p.name,100),role:text(p.role,160),headline:text(p.headline,160),intro:text(p.intro,600),bio:text(p.bio),email:text(p.email,254),github:url(p.github),linkedin:url(p.linkedin),resume:url(p.resume,true),contactHeading:text(p.contactHeading,160),contactText:text(p.contactText,600)},projects:rows('projects',x=>({title:text(x.title,160),category:text(x.category,100),type:text(x.type,160),summary:text(x.summary,500),description:text(x.description),bullets:strings(x.bullets),stack:strings(x.stack),image:url(x.image,true),imageAlt:text(x.imageAlt,500),imageLabel:text(x.imageLabel,100),url:url(x.url),repo:url(x.repo)})),experience:rows('experience',x=>({role:text(x.role,160),organization:text(x.organization,200),period:text(x.period,160),description:text(x.description)})),skills:rows('skills',x=>({title:text(x.title,160),items:strings(x.items),description:text(x.description,600)})),education:{degree:text(e.degree,300),institution:text(e.institution,200),graduation:text(e.graduation,160),grade:text(e.grade,100),coursework:strings(e.coursework)},certifications:rows('certifications',x=>({title:text(x.title,200),issuer:text(x.issuer,200)}))};
}

export async function createPortfolioServer({dataDir=path.join(base,'.data'),publicDir=path.join(base,'public'),secureCookies=process.env.SECURE_COOKIES==='true'}={}) {
  await mkdir(dataDir,{recursive:true});await mkdir(path.join(publicDir,'uploads'),{recursive:true});
  const contentPath=path.join(dataDir,'content.json'),ownerPath=path.join(dataDir,'owner.json'),setupPath=path.join(dataDir,'setup-token');
  async function atomic(file,value){const tmp=file+'.'+token()+'.tmp';await writeFile(tmp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
  try{await stat(contentPath);}catch{await atomic(contentPath,JSON.parse(await readFile(path.join(base,'content.seed.json'),'utf8')));}
  let owner;try{owner=JSON.parse(await readFile(ownerPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let setupToken; if(!owner){try{setupToken=await readFile(setupPath,'utf8');}catch{setupToken=token();await atomic(setupPath,setupToken);}}
  const sessions=new Map(),attempts=new Map();let setupBusy=false,saveBusy=false;
  const readContent=async()=>{const data=JSON.parse(await readFile(contentPath,'utf8'));return {...data,story:data.story??defaultStory};};
  const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"};
  const server=http.createServer(async(req,res)=>{
    for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const host=req.headers.host||'localhost';const u=new URL(req.url,`http://${host}`);const route=u.pathname;
      if(route.startsWith('/api/')){
        res.setHeader('Cache-Control','no-store');
        if(!['GET','HEAD'].includes(req.method)){
          const origin=req.headers.origin;
          if(!origin||!['http:','https:'].includes(new URL(origin).protocol)||new URL(origin).host!==host)throw new HttpError(403,'This request must come from your website.');
          if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'Cross-site requests are blocked.');
        }
        let session;const rawCookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('portfolio_session='))?.slice(18);
        if(rawCookie){const key=hash(rawCookie);session=sessions.get(key);if(session&&session.expires<Date.now()){sessions.delete(key);session=undefined;}}
        const requireOwner=()=>{if(!session)throw new HttpError(401,'Sign in to edit your portfolio.');};
        async function body(max=350000){let size=0,parts=[];for await(const c of req){size+=c.length;if(size>max)throw new HttpError(413,'The file or request is too large.');parts.push(c);}return Buffer.concat(parts);}
        async function input(){if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'Expected JSON data.');try{return JSON.parse((await body()).toString());}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Invalid JSON data.');}}
        const authRate=()=>{const ip=req.socket.remoteAddress||'unknown';const a=attempts.get(ip);if(a&&a.until>Date.now()&&a.count>=8)throw new HttpError(429,'Too many attempts. Try again in 15 minutes.');if(!a||a.until<Date.now())attempts.set(ip,{count:1,until:Date.now()+900000});else a.count++;};
        const issueSession=()=>{const t=token();sessions.set(hash(t),{expires:Date.now()+43200000});res.setHeader('Set-Cookie',`portfolio_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies?'; Secure':''}`);};
        if(route==='/api/content'&&req.method==='GET')return json(200,{content:await readContent()});
        if(route==='/api/session'&&req.method==='GET')return json(200,{authenticated:!!session,needsSetup:!owner});
        if(route==='/api/setup'&&req.method==='POST'){
          if(owner||setupBusy)throw new HttpError(409,'Your owner account is already configured.');authRate();const data=await input();
          if(!same(data.token,setupToken))throw new HttpError(403,'Use the private setup link shown when the server starts.');
          if(typeof data.password!=='string'||data.password.length<12||data.password.length>256)throw new HttpError(400,'Choose a password with 12 to 256 characters.');
          setupBusy=true;try{const salt=token();const passwordHash=(await scrypt(data.password,salt,64)).toString('hex');const next={salt,passwordHash};await atomic(ownerPath,next);owner=next;setupToken=undefined;await atomic(setupPath,'used');issueSession();return json(200,{ok:true});}finally{setupBusy=false;}
        }
        if(route==='/api/login'&&req.method==='POST'){
          authRate();const data=await input();if(!owner||typeof data.password!=='string'||data.password.length>256)throw new HttpError(401,'The password is incorrect.');
          const candidate=(await scrypt(data.password,owner.salt,64)).toString('hex');if(!same(candidate,owner.passwordHash))throw new HttpError(401,'The password is incorrect.');issueSession();return json(200,{ok:true});
        }
        if(route==='/api/logout'&&req.method==='POST'){if(rawCookie)sessions.delete(hash(rawCookie));res.setHeader('Set-Cookie',`portfolio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies?'; Secure':''}`);return json(200,{ok:true});}
        if(route==='/api/password'&&req.method==='POST'){
          requireOwner();authRate();const data=await input();if(typeof data.current!=='string'||data.current.length>256||typeof data.password!=='string'||data.password.length<12||data.password.length>256)throw new HttpError(400,'Check your current password and use at least 12 characters for the new one.');
          const candidate=(await scrypt(data.current,owner.salt,64)).toString('hex');if(!same(candidate,owner.passwordHash))throw new HttpError(401,'Current password is incorrect.');const salt=token();const next={salt,passwordHash:(await scrypt(data.password,salt,64)).toString('hex')};await atomic(ownerPath,next);owner=next;sessions.clear();issueSession();return json(200,{ok:true});
        }
        if(route==='/api/content'&&req.method==='PUT'){
          requireOwner();if(saveBusy)throw new HttpError(409,'Another save is in progress. Try again.');const data=validateContent(await input());saveBusy=true;try{await atomic(contentPath,data);}finally{saveBusy=false;}return json(200,{ok:true,content:data});
        }
        if(route==='/api/upload'&&req.method==='POST'){
          requireOwner();const bytes=await body(5*1024*1024);let ext;
          if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';
          else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)ext='jpg';
          else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')ext='webp';
          else if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))ext='gif';
          else if(bytes.subarray(0,5).toString()==='%PDF-')ext='pdf';
          else throw new HttpError(415,'Choose a PNG, JPG, WebP, GIF, or PDF file.');
          const name=token()+'.'+ext;await writeFile(path.join(publicDir,'uploads',name),bytes);return json(200,{url:'/uploads/'+name,type:ext});
        }
        throw new HttpError(404,'This endpoint does not exist.');
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'Method not allowed.');
      const relative=route==='/'?'index.html':route==='/admin'||route==='/admin/'?'admin.html':decodeURIComponent(route.slice(1));
      const file=path.resolve(publicDir,relative);if(!file.startsWith(path.resolve(publicDir)+path.sep))throw new HttpError(403,'Access denied.');
      let bytes;try{bytes=await readFile(file);}catch{throw new HttpError(404,'Page not found.');}
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':route.startsWith('/uploads/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){if(res.headersSent)return res.end();json(error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'});}
  });
  return {server,setupToken,readContent};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server,setupToken}=await createPortfolioServer();const port=Number(process.env.PORT||5173);const host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>{console.log(`Portfolio: http://localhost:${port}`);console.log(`Editor: http://localhost:${port}/admin`);if(setupToken)console.log(`Private first-time setup: http://localhost:${port}/admin#setup=${setupToken}`);});
}
