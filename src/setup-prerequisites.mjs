import {resolveExecutable} from './platform.mjs';

// Resolve once during inspection, rather than assuming Chrome inherits the
// installing terminal's PATH. Never replace a missing explicit selection with
// another executable found later on PATH.
export async function executableAt(selected, workspace = process.cwd()) {
  return resolveExecutable(selected, workspace);
}
