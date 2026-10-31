import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fault} from '../extension/protocol.js';
import {SUPPORT, requiresSupportContract} from './compatibility.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const EXTENSION_ID = 'dlkpkeiejlgggeoibejpoajedoelfcli';
export const HOST_NAME = 'com.qa_browser.bridge';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const PERMISSIONS = ['tabs','tabGroups','storage','nativeMessaging','alarms','debugger'];
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function chromeVersion(version) {
  const rc = /^0\.2\.0-rc\.([1-9]\d*)$/.exec(version);
  if (rc && +rc[1] <= 65535) return `0.1.99.${rc[1]}`;
  if (/^\d+\.\d+\.\d+$/.test(version) && version.split('.').every(n => +n <= 65535 && String(+n) === n)) return version;
  throw fault('RELEASE_VERSION_INVALID', 'Unsupported release/Chrome version mapping.');
}
export async function releaseManifest(root = ROOT) {
  const pkg = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const original = JSON.parse(await fs.readFile(path.join(root,'extension/manifest.json'),'utf8'));
  if (!original.key) throw fault('RELEASE_IDENTITY_INVALID','The fixed public extension key is missing.');
  const id = [...crypto.createHash('sha256').update(Buffer.from(original.key,'base64')).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
  if (id !== EXTENSION_ID) throw fault('RELEASE_IDENTITY_INVALID','The public key does not identify Latch.');
  if(original.host_permissions||original.content_scripts||original.externally_connectable||original.optional_permissions||original.permissions?.some(p=>!PERMISSIONS.includes(p)))throw fault('RELEASE_MANIFEST_INVALID','Unexpected extension access declarations.');
  return {...original,version:chromeVersion(pkg.version),version_name:pkg.version,permissions:PERMISSIONS,
    ...(requiresSupportContract(pkg.version) ? {minimum_chrome_version: SUPPORT.minimumChrome} : {})};
}
export async function filesIn(dir, prefix = '') {
  const result=[];
  for(const entry of (await fs.readdir(path.join(dir,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name=path.posix.join(prefix,entry.name);
    if(entry.isSymbolicLink())throw fault('RELEASE_SYMLINK','Release payload must contain regular files/directories.');
    if(entry.isDirectory())result.push(...await filesIn(dir,name));else if(entry.isFile())result.push(name);else throw fault('RELEASE_FILE_INVALID','Unsupported release file.');
  }
  return result.sort();
}
export async function verifyKit(dir) {
  const descriptor=JSON.parse(await fs.readFile(path.join(dir,'release.json'),'utf8'));
  if(descriptor.schema!==1||descriptor.extensionId!==EXTENSION_ID||descriptor.hostName!==HOST_NAME||descriptor.chromeVersion!==chromeVersion(descriptor.version)||descriptor.nativeSchema!==4||descriptor.uiControl!==1||descriptor.nodeVersion!=='v22.21.1'||descriptor.cliVersion!=='0.1.20')throw fault('RELEASE_INVALID','Invalid release descriptor.');
  if(requiresSupportContract(descriptor.version)&&JSON.stringify(descriptor.support)!==JSON.stringify(SUPPORT))throw fault('RELEASE_SUPPORT_INVALID','Release support contract is missing or differs from this runtime.');
  const names=await filesIn(dir),expected=Object.keys(descriptor.files).sort();
  if(JSON.stringify(names.filter(n=>n!=='release.json'))!==JSON.stringify(expected))throw fault('RELEASE_INVENTORY_CHANGED','Release file inventory changed.');
  for(const name of expected)if(hash(await fs.readFile(path.join(dir,name)))!==descriptor.files[name])throw fault('RELEASE_HASH_CHANGED','Release file hash changed: '+name);
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'extension/manifest.json'),'utf8'));
  if(JSON.stringify([...manifest.permissions].sort())!==JSON.stringify([...PERMISSIONS].sort())||manifest.version!==descriptor.chromeVersion||manifest.key!== (await releaseManifest(dir)).key)throw fault('RELEASE_MANIFEST_INVALID','Native manifest differs from the release contract.');
  const pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  if(pkg.version!==descriptor.version||pkg.dependencies?.ws!=='8.22.0')throw fault('RELEASE_VERSION_INVALID','Package and release contract differ.');
  if(requiresSupportContract(pkg.version)&&(manifest.minimum_chrome_version!==SUPPORT.minimumChrome||pkg.engines?.node!==SUPPORT.node.slice(1)))throw fault('RELEASE_SUPPORT_INVALID','Chrome/Node prerequisites differ from the release contract.');
  if(requiresSupportContract(pkg.version))await fs.access(path.join(dir,'SUPPORT.md'));
  const assets=[manifest.background?.service_worker,manifest.action?.default_popup,...Object.values(manifest.icons||{}),...Object.values(manifest.action?.default_icon||{})];
  const asset=async name=>{if(typeof name!=='string'||!name||path.isAbsolute(name)||name.split('/').includes('..'))throw fault('RELEASE_ASSET_INVALID','Invalid extension asset path.');await fs.access(path.join(dir,'extension',name));};
  for(const name of assets)await asset(name);
  const popup=await fs.readFile(path.join(dir,'extension',manifest.action.default_popup),'utf8');
  for(const match of popup.matchAll(/(?:src|href)=["']([^"']+)["']/g))await asset(path.posix.join(path.posix.dirname(manifest.action.default_popup),match[1]));
  const ws=JSON.parse(await fs.readFile(path.join(dir,'node_modules/ws/package.json'),'utf8'));
  if(ws.version!=='8.22.0')throw fault('RELEASE_DEPENDENCY_INVALID','Pinned ws dependency missing.');
  for(const name of ['node_modules/ws/LICENSE','third_party/playwright/LICENSE','third_party/playwright/SOURCES.md','skills/latch/SKILL.md'])await fs.access(path.join(dir,name));
  for(const name of names.filter(n=>/\.(?:mjs|js)$/.test(n)&&!n.startsWith('node_modules/'))) {
    const source=await fs.readFile(path.join(dir,name),'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\(?)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target=path.resolve(dir,path.dirname(name),match[1]);
      if(!target.startsWith(path.resolve(dir)+path.sep))throw fault('RELEASE_IMPORT_ESCAPE','Module import escapes the kit.');
      await fs.access(target);
    }
  }
  return descriptor;
}
