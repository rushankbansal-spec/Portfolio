import { get, put, BlobPreconditionFailedError } from '@vercel/blob';

const statePath='portfolio-private/state.json';
const options=()=>({access:'private',...(process.env.BLOB_READ_WRITE_TOKEN?{token:process.env.BLOB_READ_WRITE_TOKEN}:{})});
export function createBlobStore({get:read=get,put:write=put}={}) {
  async function readState() {
    const result=await read(statePath,{...options(),useCache:false});
    if(!result)return null;
    return {value:await new Response(result.stream).json(),etag:result.blob.etag};
  }
  return {
    readState,
    async transaction(initial,mutate) {
      for(let attempt=0;attempt<5;attempt++) {
        const previous=await readState();
        const value=previous?previous.value:initial();
        const result=await mutate(value);
        try {
          await write(statePath,JSON.stringify(value),{
            ...options(),addRandomSuffix:false,allowOverwrite:!!previous,
            ...(previous?{ifMatch:previous.etag}:{}),contentType:'application/json',cacheControlMaxAge:60,
          });
          return result;
        } catch(error) {
          if(error instanceof BlobPreconditionFailedError)continue;
          if(!previous && await readState())continue;
          throw error;
        }
      }
      const error=new Error('Another change is being saved. Please try again.');error.status=409;throw error;
    },
    async writeUpload(name,bytes,contentType) {
      await write('portfolio-private/uploads/'+name,bytes,{...options(),addRandomSuffix:false,contentType});
    },
    async readUpload(name) {
      return read('portfolio-private/uploads/'+name,{...options(),useCache:false});
    },
  };
}
