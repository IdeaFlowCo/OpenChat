import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BeeperForegroundLease,localKeychainToken,main} from '../../../scripts/beeper-client/foreground.mjs';
it('holds an OS-released exclusive foreground lease, rejects another runner and permits a clean successor',()=>{
 const directory=mkdtempSync(join(tmpdir(),'beeper-cli-'));
 try{const first=new BeeperForegroundLease(directory);expect(()=>new BeeperForegroundLease(directory)).toThrow('foreground_already_running');expect(statSync(join(directory,'beeper-process.db')).mode&0o077).toBe(0);first.close();new BeeperForegroundLease(directory).close();}finally{rmSync(directory,{recursive:true,force:true});}
});
it('never enrolls, reads a source or starts a runner from a noninteractive invocation',async()=>{
 await expect(main(['run','--connection','a'.repeat(48)])).rejects.toThrow('local_interactive_terminal_required');
});
it('does not run a Keychain lookup while configuring/importing the callback and refuses malformed designated fields',async()=>{
 const invoke=vi.fn();const callback=localKeychainToken({service:'owner-designated-beeper',account:'owner-designated-account'},invoke);expect(invoke).not.toHaveBeenCalled();
 expect(()=>localKeychainToken({service:'bad\nservice',account:'owner'},invoke)).toThrow();
 if(process.platform!=='darwin'){await expect(callback()).rejects.toThrow('mac_source_required');expect(invoke).not.toHaveBeenCalled();}
});
