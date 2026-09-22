export const SOURCE_IO_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const ROOT='/workspace/app', C=fs.constants;
const excluded=new Set(['node_modules','dist','.git','.cache']);
function valid(name){return name && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && name.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!p.startsWith('.env')&&!excluded.has(p)&&!['id_rsa','id_ed25519'].includes(p))&&!/\.(pem|key)$/i.test(name)}
function at(fd,name){return '/proc/self/fd/'+fd+'/'+name}
function openDir(base,name,create){let p=at(base,name);if(create&&!fs.existsSync(p))fs.mkdirSync(p,{mode:0o755});return fs.openSync(p,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW)}
function locate(root,name,create){if(!valid(name))throw Error('SOURCE_PATH_REJECTED');let fd=fs.dupSync?fs.dupSync(root):fs.openSync('/proc/self/fd/'+root,C.O_RDONLY|C.O_DIRECTORY);let parts=name.split('/');try{for(let p of parts.slice(0,-1)){let next=openDir(fd,p,create);fs.closeSync(fd);fd=next}return {fd,name:parts.at(-1)}}catch(e){fs.closeSync(fd);throw e}}
function inventory(fd,prefix=''){let result=[];for(const entry of fs.readdirSync('/proc/self/fd/'+fd,{withFileTypes:true})){const name=prefix+entry.name;if(!valid(name))continue;if(entry.isSymbolicLink())throw Error('SOURCE_SYMLINK_REJECTED');if(entry.isDirectory()){const child=openDir(fd,entry.name,false);try{result.push(...inventory(child,name+'/'))}finally{fs.closeSync(child)}}else if(entry.isFile()){const f=fs.openSync(at(fd,entry.name),C.O_RDONLY|C.O_NOFOLLOW);try{const size=fs.fstatSync(f).size;if(size>524288)throw Error('SOURCE_FILE_TOO_LARGE');result.push({path:name,size})}finally{fs.closeSync(f)}}else throw Error('SOURCE_SPECIAL_FILE_REJECTED');if(result.length>200)throw Error('SOURCE_FILE_COUNT_LIMIT')}return result}
const staging=process.argv[2];let root;
try {
 if(!/^\/tmp\/pivloom-io\/[a-f0-9-]+\.json$/.test(staging))throw Error('INVALID_STAGING');
 const request=JSON.parse(fs.readFileSync(staging,'utf8'));
 root=fs.openSync(ROOT,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
 let result;
 if(request.op==='list'){const files=inventory(root);if(files.reduce((n,f)=>n+f.size,0)>5242880)throw Error('SOURCE_TOTAL_LIMIT');result={files:files.map(f=>f.path).sort()}}
 else {
  const loc=locate(root,request.path,request.op==='write');let file;
  try{
   if(request.op==='read'){file=fs.openSync(at(loc.fd,loc.name),C.O_RDONLY|C.O_NOFOLLOW);const stat=fs.fstatSync(file);if(!stat.isFile()||stat.size>524288)throw Error('SOURCE_FILE_REJECTED');result={data:fs.readFileSync(file).toString('base64')}}
   else if(request.op==='write'){
    const data=Buffer.from(request.data,'base64');if(data.length>524288)throw Error('SOURCE_FILE_TOO_LARGE');
    const files=inventory(root).filter(f=>f.path!==request.path);if(files.length>=200||files.reduce((n,f)=>n+f.size,0)+data.length>5242880)throw Error('SOURCE_TOTAL_LIMIT');
    file=fs.openSync(at(loc.fd,loc.name),C.O_WRONLY|C.O_CREAT|C.O_TRUNC|C.O_NOFOLLOW,0o644);if(!fs.fstatSync(file).isFile())throw Error('SOURCE_FILE_REJECTED');fs.writeFileSync(file,data);fs.fchmodSync(file,0o644);if(process.getuid()===0)fs.fchownSync(file,1000,1000);result={ok:true};
   } else throw Error('UNKNOWN_SOURCE_ACTION');
  }finally{if(file!==undefined)fs.closeSync(file);fs.closeSync(loc.fd)}
 }
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1}
finally{if(root!==undefined)fs.closeSync(root);if(staging&&/^\/tmp\/pivloom-io\/[a-f0-9-]+\.json$/.test(staging))fs.rmSync(staging,{force:true})}
`;

export const REACT_TEMPLATE: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "pivloom-generated-app",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        build: "tsc --noEmit && vite build",
        preview: "vite preview --host 0.0.0.0 --port 4173 --strictPort",
      },
      dependencies: { react: "19.2.4", "react-dom": "19.2.4" },
      devDependencies: {
        "@types/react": "19.2.14",
        "@types/react-dom": "19.2.3",
        typescript: "5.9.3",
        vite: "8.3.0",
      },
    },
    null,
    2,
  ),
  "index.html":
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Pivloom Preview</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
      },
      include: ["src"],
    },
    null,
    2,
  ),
  "src/main.tsx":
    "import {createRoot} from 'react-dom/client';\nimport App from './App';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<App/>);\n",
  "src/App.tsx":
    "export default function App(){return <main><h1>开始构建你的应用</h1></main>}\n",
  "src/style.css":
    "*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f6f7fb;color:#172033}main{max-width:960px;margin:32px auto;padding:24px}button,input,select,textarea{font:inherit}button{cursor:pointer}label{display:block}@media(max-width:420px){main{margin:0;padding:16px}}\n",
};

export const STATIC_PREVIEW_SCRIPT = String.raw`
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root='/workspace/app/dist';const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'};
http.createServer((req,res)=>{try{const url=new URL(req.url,'http://localhost');let relative=decodeURIComponent(url.pathname);const target=path.resolve(root,'.'+relative);if(!target.startsWith(root+'/')&&target!==root){res.writeHead(403);return res.end()}let file=target===root||!fs.existsSync(target)?path.join(root,'index.html'):target;const actual=fs.realpathSync(file);if(!actual.startsWith(root+'/')||!fs.statSync(actual).isFile()){res.writeHead(403);return res.end()}res.writeHead(200,{'Content-Type':mime[path.extname(actual)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(actual).pipe(res)}catch{res.writeHead(404);res.end()}}).listen(4173,'0.0.0.0');
`;
