import { readFile } from 'node:fs/promises';
import { createHostedHandler } from '../lib/hosted-api.mjs';
import { createBlobStore } from '../lib/blob-store.mjs';

const seed=JSON.parse(await readFile(new URL('../content.seed.json',import.meta.url),'utf8'));
const handler=createHostedHandler({store:createBlobStore(),seed,setupToken:process.env.PORTFOLIO_SETUP_TOKEN,secureCookies:true});
export default handler;
