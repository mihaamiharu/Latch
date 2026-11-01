import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT,chromeVersion} from '../../src/release.mjs';

// Read the expected identity from committed source, independently of the built
// descriptor. The same install/recovery assertions must run on the final kit,
// rather than accidentally continuing to exercise a retained RC directory.
export const CANDIDATE_VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
export const CANDIDATE_CHROME_VERSION=chromeVersion(CANDIDATE_VERSION);
export const CANDIDATE_KIT=path.join(ROOT,'dist','latch-'+CANDIDATE_VERSION);
