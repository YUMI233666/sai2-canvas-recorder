import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { referenceModels } from './web/reference-models.js';

const modelSource = 'https://raw.githubusercontent.com/hinzka/52blendshapes-for-VRoid-face/756f5abab7d2295ad5b5dbc2cd86972c388c48d2/';

async function modelBytes({file,upstream,sha256}) {
  const cache = join('..','downloads','hinzka',file);
  let bytes;
  try {
    bytes = readFileSync(cache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      const response = await fetch(modelSource+upstream,{signal:AbortSignal.timeout(120000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw new Error(`Cannot download ${upstream}. For an offline build place the original file at ${cache}.`,{cause});
    }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`SHA-256 mismatch for ${file}; use the original file from ${modelSource+upstream}`);
  }
  return bytes;
}

const out = process.argv[2] ?? '../build/pose-studio/web';
mkdirSync(out, {recursive:true});
cpSync('web', out, {recursive:true});
cpSync('assets/base-female.glb', join(out, 'mannequin.glb'));
for (const [file,bytes] of await Promise.all(referenceModels.map(async reference=>[reference.file,await modelBytes(reference)]))) {
  writeFileSync(join(out,file),bytes);
}
const three = 'node_modules/three';
mkdirSync(join(out,'vendor'), {recursive:true});
for (const file of ['three.module.js', 'three.core.js']) {
  cpSync(join(three,'build',file), join(out,'vendor',file));
}
for (const file of ['controls/OrbitControls.js','controls/TransformControls.js','loaders/GLTFLoader.js',
  'loaders/FBXLoader.js','curves/NURBSCurve.js','curves/NURBSUtils.js','libs/fflate.module.js','utils/BufferGeometryUtils.js']) {
  mkdirSync(join(out,'vendor',file.split('/')[0]), {recursive:true});
  cpSync(join(three,'examples/jsm',file), join(out,'vendor',file));
}
mkdirSync(join(out,'icons'), {recursive:true});
for (const icon of ['bone','box','camera','focus','sun','download','rotate-ccw','person-standing','save','trash-2','folder-open']) {
  cpSync('node_modules/lucide-static/icons/'+icon+'.svg', join(out,'icons',icon+'.svg'));
}
cpSync(join(three,'LICENSE'), join(out,'Three-LICENSE.txt'));
cpSync('node_modules/lucide-static/LICENSE', join(out,'Lucide-LICENSE.txt'));
cpSync('assets/LICENSE.md', join(out,'Mannequin-LICENSE.md'));
cpSync('assets/Hinzka-NOTICE.md', join(out,'Hinzka-NOTICE.md'));
cpSync('assets/fflate-LICENSE.txt', join(out,'fflate-LICENSE.txt'));
