import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {fault} from '../extension/protocol.js';

// Resolve once during inspection, rather than assuming Chrome inherits the
// installing terminal's PATH. Never replace a missing explicit selection with
// another executable found later on PATH.
export async function executableAt(selected, workspace = process.cwd()) {
  const candidates = selected.includes('/') ? [path.resolve(workspace,selected)] :
    (process.env.PATH || '').split(path.delimiter).map(dir=>path.resolve(workspace,dir||'.',selected));
  for(const candidate of candidates){
    try{
      const resolved=await fs.realpath(candidate),stat=await fs.stat(resolved);
      if(!stat.isFile())continue;
      await fs.access(resolved,constants.X_OK);return resolved;
    }catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
  }
  throw fault('SETUP_EXECUTABLE_UNAVAILABLE',`Cannot resolve the selected executable: ${selected}. Supply its absolute path; no installation changes were made.`);
}
