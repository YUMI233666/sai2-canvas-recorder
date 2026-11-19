import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/pose-studio/web';
mkdirSync(out, {recursive:true});
cpSync('web', out, {recursive:true});
cpSync('assets/base-female.glb', join(out, 'mannequin.glb'));
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
cpSync('assets/fflate-LICENSE.txt', join(out,'fflate-LICENSE.txt'));
