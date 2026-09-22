import { Sandbox,ConnectionConfig } from '@alibaba-group/opensandbox';
import fs from 'node:fs/promises';
const dir='/opt/pivloom/g0-sandbox';const variant=process.argv[2];
const sandboxId=JSON.parse(await fs.readFile(`${dir}/active-${variant}.json`,'utf8')).id;
const key=(await fs.readFile(`${dir}/control-key`,'utf8')).trim();
const sb=await Sandbox.connect({sandboxId,connectionConfig:new ConnectionConfig({domain:'127.0.0.1:18080',protocol:'http',apiKey:key})});
try {
 const cmd=process.argv[3];
 const r=await sb.commands.run(cmd,{workingDirectory:'/workspace',timeoutSeconds:90});
 const row={at:new Date().toISOString(),command:cmd,id:r.id,exitCode:r.exitCode,error:r.error,stdout:r.logs.stdout.map(x=>x.text).join('\n'),stderr:r.logs.stderr.map(x=>x.text).join('\n')};
 await fs.appendFile(`${dir}/browser-${variant}.jsonl`,JSON.stringify(row)+'\n');
 console.log(JSON.stringify(row));
 if(r.error||(r.exitCode!=null&&r.exitCode!==0))process.exitCode=1;
}finally{await sb.close()}
