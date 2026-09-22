import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { test, expect } from 'vitest';
import { createArtifactStore } from '../../src/storage/artifacts.js';

test('private screenshot objects are hash verified and cannot be read using another owner path',async()=>{
  const objects=new Map<string,Uint8Array>();
  const store=createArtifactStore({url:'http://fixture.invalid',secret:'fixture',objects:{
    upload:async(key,body)=>{objects.set(key,body);},download:async(key)=>{const value=objects.get(key);if(!value)throw Error('missing');return value;},
  }});
  const scope={ownerId:randomUUID(),projectId:randomUUID(),revisionId:randomUUID()};
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const record=await store.save(scope,{base64:bytes.toString('base64'),mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')});
  expect(await store.load(scope,record)).toEqual(bytes);
  await expect(store.load({...scope,ownerId:randomUUID()},record)).rejects.toMatchObject({code:'ARTIFACT_UNAVAILABLE'});
  objects.set(record.key,Buffer.from('corrupt'));
  await expect(store.load(scope,record)).rejects.toMatchObject({code:'ARTIFACT_UNAVAILABLE'});
});

test('an expired check does not begin a screenshot readback after its upload returns',async()=>{
  const controller=new AbortController();let downloads=0;
  const store=createArtifactStore({url:'http://fixture.invalid',secret:'fixture',objects:{
    upload:async()=>{controller.abort('REVIEW_TIMEOUT');},download:async()=>{downloads++;return new Uint8Array();},
  }});
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  await expect(store.save({ownerId:randomUUID(),projectId:randomUUID(),revisionId:randomUUID()},
    {base64:bytes.toString('base64'),mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex')},controller.signal)).rejects.toBeDefined();
  expect(downloads).toBe(0);
});
