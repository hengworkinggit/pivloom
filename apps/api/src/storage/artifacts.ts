import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { CheckArtifact } from '@pivloom/contracts';
import type { SourceScope } from './source.js';
import { ApiFailure } from '../routes/errors.js';

export interface StoredArtifact extends CheckArtifact { key: string; bytes: number }
export interface ArtifactObjects { upload(key: string, body: Uint8Array): Promise<void>; download(key: string): Promise<Uint8Array> }
export interface ArtifactStore {
  save(scope: SourceScope, image: { base64: string; mimeType: 'image/png'; sha256: string }, signal?: AbortSignal): Promise<StoredArtifact>;
  load(scope: SourceScope, artifact: StoredArtifact, signal?: AbortSignal): Promise<Buffer>;
}
const MAX_BYTES=2*1024*1024;
const failure=()=>new ApiFailure(503,'ARTIFACT_UNAVAILABLE','检查截图暂时无法读取或完整性验证失败。',true);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function key(scope:SourceScope,id:string){
  for(const value of [scope.ownerId,scope.projectId,scope.revisionId,id])if(!z.uuid().safeParse(value).success)throw failure();
  return `${scope.ownerId}/${scope.projectId}/${scope.revisionId}/checks/${id}.png`;
}
function check(bytes:Uint8Array,sha256:string){
  if(bytes.length<8||bytes.length>MAX_BYTES||!Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))||hash(bytes)!==sha256)throw failure();
}
export function createArtifactStore(config:{url:string;secret:string;objects?:ArtifactObjects}):ArtifactStore{
  const bucket=createClient(config.url,config.secret,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>globalThis.fetch(input,{...init,signal:AbortSignal.timeout(15000)})}}).storage.from('pivloom-private');
  const objects=config.objects??{
    async upload(path:string,body:Uint8Array){if((await bucket.upload(path,body,{contentType:'image/png',upsert:false})).error)throw failure();},
    async download(path:string){const result=await bucket.download(path);if(result.error||result.data.size>MAX_BYTES)throw failure();return new Uint8Array(await result.data.arrayBuffer());},
  };
  async function load(scope:SourceScope,artifact:StoredArtifact,signal?:AbortSignal){
    try{
      if(artifact.key!==key(scope,artifact.id)||artifact.mimeType!=='image/png')throw failure();
      signal?.throwIfAborted();
      const bytes=await objects.download(artifact.key);signal?.throwIfAborted();check(bytes,artifact.sha256);if(bytes.length!==artifact.bytes)throw failure();return Buffer.from(bytes);
    }catch{throw failure();}
  }
  return {load,async save(scope,image,signal){
    if(image.base64.length>Math.ceil(MAX_BYTES/3)*4||image.mimeType!=='image/png')throw failure();
    const bytes=Buffer.from(image.base64,'base64');check(bytes,image.sha256);
    const id=randomUUID(),artifact:StoredArtifact={id,key:key(scope,id),bytes:bytes.length,mimeType:'image/png',sha256:image.sha256};
    try{signal?.throwIfAborted();await objects.upload(artifact.key,bytes);signal?.throwIfAborted();await load(scope,artifact,signal);return artifact;}catch{throw failure();}
  }};
}
