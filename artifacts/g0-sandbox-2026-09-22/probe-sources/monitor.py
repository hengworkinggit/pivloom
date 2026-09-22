from pathlib import Path
import json,subprocess,time,urllib.request
p=Path('/opt/pivloom/g0-sandbox')
start=time.monotonic();tick=0;containers=[]
with (p/'resource-samples.jsonl').open('a',buffering=1) as f:
 while not (p/'monitor-stop').exists() and time.monotonic()-start<7200:
  try:
   mem={k:int(v.split()[0]) for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())}
   row={'at':time.time(),'availableMiB':round(mem['MemAvailable']/1024,1),'swapUsedMiB':round((mem['SwapTotal']-mem['SwapFree'])/1024,1),'containers':[]}
   if tick%5==0:
    ids=subprocess.run(['docker','ps','-q','--no-trunc'],capture_output=True,text=True).stdout.split()
    containers=[]
    for cid in ids:
     q=subprocess.run(['docker','inspect',cid,'--format','{{.State.Pid}} {{.Name}}'],capture_output=True,text=True).stdout.split()
     if len(q)!=2:continue
     cg=Path('/proc/'+q[0]+'/cgroup')
     if cg.exists():
      rel=cg.read_text().split('0::',1)[1].strip()
      containers.append((cid,q[1],Path('/sys/fs/cgroup'+rel)))
    try:
     t=time.monotonic()
     r=urllib.request.urlopen('http://127.0.0.1:3000/',timeout=2)
     row['oldSite']={'status':r.status,'seconds':round(time.monotonic()-t,4)}
    except Exception as e:row['oldSite']={'error':type(e).__name__}
   for cid,name,cgroup in containers:
    if (cgroup/'memory.current').exists():
     row['containers'].append({'id':cid,'name':name,'currentMiB':round(int((cgroup/'memory.current').read_text())/1048576,2),'peakMiB':round(int((cgroup/'memory.peak').read_text())/1048576,2)})
   f.write(json.dumps(row)+'\n');tick+=1
  except Exception as e:f.write(json.dumps({'at':time.time(),'monitorError':type(e).__name__})+'\n')
  time.sleep(1)
