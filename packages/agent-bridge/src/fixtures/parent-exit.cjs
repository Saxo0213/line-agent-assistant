const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const [host,node,tree,output]=process.argv.slice(2);
const child=spawn(host,[randomUUID(),String(process.pid),'pipe',node,process.cwd(),tree,'root',output],{stdio:'ignore',detached:true,windowsHide:true,shell:false});
child.on('error',()=>process.exit(2));
const timer=setInterval(()=>{
  try {
    if(fs.readFileSync(output,'utf8').trim().split('\n').length===3) {
      clearInterval(timer);process.stdout.write(String(child.pid)+'\n',()=>process.exit(0));
    }
  } catch{}
},20);
setTimeout(()=>process.exit(3),8000).unref();
