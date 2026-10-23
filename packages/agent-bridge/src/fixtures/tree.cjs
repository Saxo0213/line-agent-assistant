const {spawn} = require('node:child_process');
const fs = require('node:fs');
const [level, output] = process.argv.slice(2);
fs.appendFileSync(output, JSON.stringify({level,pid:process.pid,ppid:process.ppid}) + '\n');
if (level !== 'grandchild') {
  spawn(process.execPath,[__filename,level === 'root' ? 'child' : 'grandchild',output],{stdio:'ignore',shell:false,windowsHide:true,detached:true});
}
setInterval(()=>{},1000);
