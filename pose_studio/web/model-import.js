import { Box3, Group, LoadingManager, Vector3 } from 'three';
import { FBXLoader } from './vendor/loaders/FBXLoader.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { LIMBS, shoulderBone, shoulderSlots } from './rig.js';

const extension = /\.(gltf|glb|fbx|vrm)$/i;
const localRoot = new URL('./model-assets/',location.href).href;
const canon = name => name.split(/[:|]/).at(-1).toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^mixamorig\d*/,'');
const slots = [
  ['root','胯部','hips','pelvis','hip'],
  ['spine01','躯干','spine','spine1','spine_01','chest','waist'],
  ['head','头部','head','head_01'],
];
for (const [i,[label,upper,lower,end]] of LIMBS.entries()) {
  const left = i%2===0, side = left ? 'left':'right', s = left ? 'l':'r', zh = label[0];
  const leg = i>=2;
  const aliases = (...names) => names.flatMap(name=>[side+name,name+side,name+s,s+name]);
  slots.push([upper,zh+(leg?'大腿':'上臂'),side+(leg?'UpperLeg':'UpperArm'),...aliases(...(leg?['upleg','thigh','upperleg01']:['arm','upper_arm','upperarm01']))],
    [lower,zh+(leg?'小腿':'前臂'),side+(leg?'LowerLeg':'LowerArm'),...aliases(...(leg?['leg','calf','shin','lowerleg01']:['forearm','forearm01','lower_arm','lowerarm01']))],
    [end,zh+(leg?'脚踝':'手腕'),side+(leg?'Foot':'Hand'),...aliases(...(leg?['foot','ankle']:['wrist','hand']))]);
}
export const requiredBoneSlots = slots.length;
export const boneSlots = [...slots,...shoulderSlots];

const descendant = (child,parent) => {
  while (child?.parent) {
    child = child.parent;
    if (child===parent) return true;
  }
  return false;
};

export function mappingIssue(mapping) {
  const missing = slots.filter(([id])=>!mapping[id]).map(([,label])=>label);
  if (missing.length) return '缺少骨骼：'+missing.join('、');
  const assigned = Object.values(mapping).filter(Boolean);
  if (new Set(assigned).size!==assigned.length) return '同一根骨骼不能分配给多个部位。';
  if (!descendant(mapping.spine01,mapping.root) || !descendant(mapping.head,mapping.spine01)) {
    return '头部、躯干和胯部不在同一条骨骼链。';
  }
  for (const [i,[label,a,b,c]] of LIMBS.entries()) {
    if (!descendant(mapping[a],i<2?mapping.spine01:mapping.root) ||
        !descendant(mapping[b],mapping[a]) || !descendant(mapping[c],mapping[b])) {
      return label+'的骨骼上下级关系不正确。';
    }
  }
  for (const [i,[id,label]] of shoulderSlots.entries()) {
    const shoulder = mapping[id];
    if (shoulder && (!descendant(shoulder,mapping.spine01) || !descendant(mapping[LIMBS[i][1]],shoulder))) {
      return label+'骨骼必须位于躯干与同侧上臂之间。';
    }
  }
  return '';
}

function commonMapping(bones, semantic) {
  return Object.fromEntries(slots.map(([id,,human,...aliases])=>{
    const lookup = new Set([id,human,...aliases].map(canon));
    const candidates = bones.filter(b=>lookup.has(canon(b.name)));
    const exact = candidates.filter(b=>[id,human].some(name=>canon(name)===canon(b.name)));
    return [id,semantic[human] ?? (exact.length===1 ? exact[0] : candidates.length===1 ? candidates[0] : null)];
  }));
}

function localResources(files) {
  const manager = new LoadingManager();
  const urls = new Map(), missing = new Set();
  manager.setURLModifier(url => {
    if (/^data:/i.test(url) || url.startsWith('blob:'+location.origin+'/')) return url;
    let path;
    try {
      const resolved = new URL(url,localRoot);
      if (resolved.href.startsWith(localRoot)) path = decodeURIComponent(resolved.pathname).replaceAll('\\','/');
    } catch {}
    const name = path?.split('/').at(-1)?.toLowerCase();
    const matches = name ? files.filter(file=>file.name.toLowerCase()===name) : [];
    if (matches.length===1) {
      if (!urls.has(matches[0])) urls.set(matches[0],URL.createObjectURL(matches[0]));
      return urls.get(matches[0]);
    }
    missing.add(name ?? '非本地资源');
    return 'data:application/octet-stream,';
  });
  manager.onError = url => { if (!missing.size) missing.add(url.startsWith('blob:')?'本地贴图':'模型资源'); };
  return {manager,missing,dispose:()=>urls.forEach(url=>URL.revokeObjectURL(url))};
}

function normalise(model, source) {
  model.position.set(0,0,0);
  model.scale.setScalar(1);
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(source,true);
  const size = box.getSize(new Vector3());
  if (box.isEmpty() || !(size.y>0) || ![size.x,size.y,size.z].every(Number.isFinite)) {
    throw Error('找不到可预览的模型网格，或模型尺寸无效。');
  }
  const center = box.getCenter(new Vector3());
  const scale = Math.min(1.7/size.y,2.0/Math.max(size.x,size.z));
  center.y = box.min.y;
  model.scale.setScalar(scale);
  model.position.copy(center).multiplyScalar(-scale);
  model.updateMatrixWorld(true);
  return size.y*scale;
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
    n=>n.toString(16).padStart(2,'0')).join('');
}

export async function importModel(files) {
  const main = files.filter(file=>extension.test(file.name));
  if (main.length!==1) throw Error('每次请选择一个 GLB、GLTF、FBX 或 VRM 主文件。');
  const [file] = main;
  const ext = file.name.match(extension)[1].toLowerCase();
  const resources = localResources(files.filter(f=>f!==file));
  try {
    const bytes = await file.arrayBuffer();
    const signature = await digest(bytes);
    let source, vrm0, metadata = {};
    if (ext==='fbx') {
      source = new FBXLoader(resources.manager).parse(bytes,localRoot);
    } else {
      const asset = await new GLTFLoader(resources.manager).parseAsync(bytes,localRoot);
      source = asset.scene;
      const extensions = asset.parser.json.extensions ?? {};
      vrm0 = extensions.VRM && !extensions.VRMC_vrm;
      const humans = extensions.VRMC_vrm?.humanoid?.humanBones ??
        Object.fromEntries((extensions.VRM?.humanoid?.humanBones ?? []).map(entry=>[entry.bone,entry]));
      const bones = [];
      source.traverse(node=>{ if (node.isBone) bones.push(node); });
      for (const b of bones) {
        const index = asset.parser.associations.get(b)?.nodes;
        const human = Object.keys(humans).find(id=>humans[id]?.node===index && Number.isInteger(index));
        if (human) metadata[human] = b;
      }
    }
    const model = new Group();
    const oriented = new Group();
    model.add(oriented);
    oriented.add(source);
    if (vrm0) oriented.rotation.y = Math.PI;
    const bones = new Set(), extras = {}, remove = [];
    source.traverse(node=>{
      if (node.isCamera || node.isLight) remove.push(node);
      if (node.isSkinnedMesh) {
        node.frustumCulled = false;
        for (const bone of node.skeleton.bones) bones.add(bone);
      }
    });
    remove.forEach(node=>node.removeFromParent());
    for (const [human,bone] of Object.entries(metadata)) if (!bones.has(bone)) delete metadata[human];
    const list = Array.from(bones);
    const mapping = commonMapping(list,metadata);
    for (const [i,[id,,human]] of shoulderSlots.entries()) {
      const shoulder = shoulderBone(mapping[LIMBS[i][1]],mapping.spine01,metadata[human]);
      if (bones.has(shoulder) && descendant(shoulder,mapping.spine01)) mapping[id] = shoulder;
    }
    for (const [i,[,,,end]] of LIMBS.entries()) {
      const side = i%2 ? 'right' : 'left';
      extras[end] = metadata[side+(i>=2?'Toes':'MiddleProximal')];
    }
    const height = normalise(model,source);
    return {model,name:file.name,key:'import-'+signature,bones:list,mapping,extras,height,
      warning:resources.missing.size ? '未加载资源：'+[...resources.missing].join('、') : '',
      dispose:resources.dispose};
  } catch (error) {
    resources.dispose();
    if (resources.missing.size) throw Error('缺少或无法读取资源：'+[...resources.missing].join('、'));
    throw error;
  }
}

export function disposeModel(model) {
  const objects = new Set(), textures = new Set(), images = new Set();
  model.traverse(node=>{
    if (!node.isMesh) return;
    objects.add(node.geometry);
    if (node.skeleton) objects.add(node.skeleton);
    for (const material of [node.material].flat()) {
      if (!material) continue;
      objects.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) {
        textures.add(value);
        if (value.image?.close) images.add(value.image);
      }
    }
  });
  for (const obj of [...objects,...textures]) obj?.dispose();
  for (const image of images) image.close();
}
