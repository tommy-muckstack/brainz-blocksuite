import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../node_modules/@blocksuite/blocks/',import.meta.url));
const version=JSON.parse(readFileSync(`${root}package.json`,'utf8')).version;
if(version!=='0.19.5')throw new Error(`Review Brainz engine patches for BlockSuite ${version}`);
const hash=value=>createHash('sha256').update(value).digest('hex');
const patches=JSON.parse(readFileSync(new URL('./engine-patches.json',import.meta.url),'utf8'));
const writes=patches.map(({file,originalHash,replacements})=>{
  const path=root+file,backup=`${path}.brainz-original`;
  const current=readFileSync(path,'utf8');
  const original=existsSync(backup)?readFileSync(backup,'utf8'):current;
  if(hash(original)!==originalHash)throw new Error(`Unexpected upstream content: ${file}`);
  let patched=original;
  for(const {find,replace} of replacements) {
    if(patched.split(find).length!==2)throw new Error(`Engine patch is not unique in ${file}: ${find.slice(0,80)}`);
    patched=patched.replace(find,replace);
  }
  if(current!==original && current!==patched)throw new Error(`Unrecognized local changes in ${file}; reinstall dependencies before patching`);
  return {path,backup,original,patched,current};
});
for(const {path,backup,original,patched,current} of writes) {
  if(current===patched)continue;
  if(!existsSync(backup))writeFileSync(backup,original);
  writeFileSync(path,patched);
}
