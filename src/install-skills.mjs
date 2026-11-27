#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  agentsCommand,
  installAgents,
  uninstallAgents,
  agentsStatus,
  targetsFor,
  sourceSkill,
} from './agents.mjs';

export {
  installAgents as installSkills,
  uninstallAgents as uninstallSkills,
  agentsStatus as skillStatus,
  targetsFor,
  sourceSkill,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || 'install';
    const result = await agentsCommand(command);
    console.log(JSON.stringify({ok: true, source: sourceSkill, ...result}, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error.message}));
    process.exitCode = 1;
  }
}
