import * as THREE from 'three';
import { OrbitControls } from './vendor/controls/OrbitControls.js';
import { TransformControls } from './vendor/controls/TransformControls.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { jointRanges, jointWorldRotation, PoseRig, setJointWorldRotation, shoulderRange, shoulderSlots } from './rig.js';
import { createMannequin, mannequins } from './mannequins.js';
import { boneSlots, disposeModel, importModel, mappingIssue, requiredBoneSlots } from './model-import.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const status = $('status');
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;
const at = new THREE.Vector3(0,.82,0);
const scene = new THREE.Scene();
let renderer, rig, camera, controls, activeDrag, frame = 0, width = 1, height = 1;
let mode = 'persp';
let activeModel, importedModel, refreshPoses;
const models = new Map();
const hinzkaKeys = {
  'import-7526838f4a45086a1d0abb23e9f38ad3f0103889f1efa70d2605ef25e7e6ef99':'hinzka-male',
  'import-36d6d242999d580bd0d3bcd8656bb2d4d5d4839f187d8198226bda905e1d9114':'hinzka-female',
};
const handles = [];
const joints = new Map();
const rotationTarget = new THREE.Object3D();
let rotation, selection, rotationStart, pressed;
scene.add(rotationTarget);
const lighting = new THREE.DirectionalLight(0xffeedb,3);
const fill = new THREE.HemisphereLight(0xe5f0ff,0x646757,1);
lighting.target.position.copy(at);
scene.add(lighting,lighting.target,fill);

function draw() {
  if (frame || !camera) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    positionRotation();
    renderer.render(scene,camera);
    syncLightBall();
    const show = $('handles').checked;
    for (const {button,bone} of handles) {
      const point = bone.getWorldPosition(new THREE.Vector3()).project(camera);
      button.hidden = !show || Math.abs(point.z) > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
      button.style.left = ((point.x+1)*width/2)+'px';
      button.style.top = ((1-point.y)*height/2)+'px';
    }
  });
}

function frustum() {
  const aspect = width/height;
  const half = Math.max(activeModel?.bones ? 1.24 : 1.13,.70/aspect);
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    Object.assign(camera,{left:-half*aspect,right:half*aspect,top:half,bottom:-half});
  }
  camera.updateProjectionMatrix();
  return half;
}

function resize() {
  width = Math.max(1,viewport.clientWidth);
  height = Math.max(1,viewport.clientHeight);
  renderer.setSize(width,height,false);
  rotation?.setSize(rotationSize());
  if (camera) frustum();
  draw();
}

function rotationSize() {
  return .5*Math.max(1,620/Math.max(height,240));
}

function resetView() {
  const half = frustum();
  const distance = half / Math.tan(rad(34/2));
  camera.zoom = 1;
  camera.position.copy(at).addScaledVector(new THREE.Vector3(.24,.11,1).normalize(),distance);
  camera.updateProjectionMatrix();
  controls.target.copy(at);
  controls.update();
  draw();
}

function useCamera(next, reset=false) {
  const old = camera && {
    target:controls.target.clone(), offset:camera.position.clone().sub(controls.target), zoom:camera.zoom
  };
  controls?.dispose();
  mode = next;
  camera = mode === 'persp' ? new THREE.PerspectiveCamera(34,1,.01,50) :
    new THREE.OrthographicCamera(-1,1,1,-1,.01,50);
  if (rotation) rotation.camera = camera;
  else setupRotation();
  controls = new OrbitControls(camera,renderer.domElement);
  controls.minDistance = .55;
  controls.maxDistance = 10;
  controls.minZoom = .35;
  controls.maxZoom = 4;
  controls.enableDamping = false;
  controls.addEventListener('change',draw);
  const half = frustum();
  if (!old || reset) resetView();
  else {
    const baseDistance = half/Math.tan(rad(34/2));
    controls.target.copy(old.target);
    if (mode === 'ortho') {
      camera.zoom = THREE.MathUtils.clamp(baseDistance/old.offset.length(),.35,4);
      camera.position.copy(old.target).add(old.offset);
    } else {
      camera.position.copy(old.target).add(old.offset.setLength(baseDistance/old.zoom));
    }
    camera.updateProjectionMatrix();
    controls.update();
  }
  document.querySelectorAll('[data-camera]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.camera===mode)));
  draw();
}

function setRange(id, value, suffix='°') {
  $(id).value = value;
  $(id+'-val').value = suffix ? value+suffix : Number(value).toFixed(1);
}

function selectJoint(id) {
  if (rotation.dragging) return;
  selection = joints.get(String(id));
  $('limb').value = selection?.id ?? '';
  rotation.detach();
  rotation.enabled = Boolean(selection && selection.kind !== 'shoulder');
  if (rotation.enabled) {
    rotation.showX = selection.kind !== 'pole';
    rotation.showY = selection.kind !== 'pole';
    positionRotation();
    rotation.attach(rotationTarget);
  }
  syncJointControls();
  draw();
}

function positionRotation() {
  if (!rotation.enabled || !selection || rotation.dragging) return;
  const {kind,bone,limb,joint} = selection;
  bone.getWorldPosition(rotationTarget.position);
  if (joint) rotationTarget.quaternion.copy(jointWorldRotation(joint));
  else if (kind === 'pole') {
    const axis = limb.end.getWorldPosition(new THREE.Vector3()).sub(limb.upper.getWorldPosition(new THREE.Vector3())).normalize();
    rotationTarget.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),axis);
  }
}

function setupRotation() {
  const canvas = renderer.domElement;
  rotation = new TransformControls(camera,canvas);
  rotation.setMode('rotate');
  rotation.setSpace('local');
  rotation.setSize(rotationSize());
  rotation.setColors(0xff6357,0x65db79,0x62a7ff,0xffdf72);
  rotation.enabled = false;
  scene.add(rotation.getHelper());
  rotation.addEventListener('change',draw);
  rotation.addEventListener('axis-changed',e => {
    if (e.value) canvas.dataset.rotationAxis = e.value;
    else delete canvas.dataset.rotationAxis;
  });
  rotation.addEventListener('dragging-changed',e => {
    controls.enabled = !e.value;
    canvas.toggleAttribute('data-rotating',e.value);
  });
  rotation.addEventListener('mouseDown',() => {
    rotationStart = selection.limb?.angle;
  });
  rotation.addEventListener('objectChange',() => {
    const {kind,limb,joint} = selection;
    if (joint) setJointWorldRotation(joint,rotationTarget.quaternion);
    else if (kind === 'pole') limb.angle = clamp(rotationStart+deg(rotation.rotationAngle),-150,150);
    rig.update();
    syncJointControls();
  });
  canvas.addEventListener('pointerdown',e => {
    pressed = e.button === 0 && !rotation.dragging ? [e.clientX,e.clientY] : null;
  });
  canvas.addEventListener('pointerup',e => {
    if (pressed && Math.hypot(e.clientX-pressed[0],e.clientY-pressed[1]) < 4) selectJoint('');
    pressed = null;
  });
  canvas.addEventListener('pointercancel',() => {
    pressed = null;
    rotation.pointerUp(null);
  });
  window.addEventListener('keydown',e => {
    if (e.key === 'Escape') selectJoint('');
  });
}

function syncJointControls() {
  $('angle-fields').hidden = !selection?.joint;
  $('pole-fields').hidden = selection?.kind !== 'pole';
  $('shoulder-fields').hidden = selection?.kind !== 'shoulder';
  $('reset-joint').disabled = !selection;
  handles.forEach(({button,id}) => button.setAttribute('aria-pressed',String(selection?.id===id)));
  if (selection?.joint) {
    const {joint} = selection;
    for (const [i,[label,min,max]] of jointRanges[joint.kind].entries()) {
      const id = 'joint-'+i;
      $(id+'-label').textContent = label;
      $(id).min = min;
      $(id).max = max;
      setRange(id,Math.round(joint.angles[i]));
    }
  } else if (selection?.kind === 'pole') {
    $('pole-label').textContent = selection.limb.leg ? '膝部朝向' : '肘部朝向';
    setRange('pole',Math.round(selection.limb.angle));
  } else if (selection?.kind === 'shoulder') {
    setRange('shoulder-lift',Math.round(selection.limb.shoulder.angle));
  }
}

function liftShoulder(limb, angle) {
  limb.shoulder.angle = clamp(angle,...shoulderRange);
  rig.update();
  syncJointControls();
  draw();
}

function relight() {
  const azimuth = rad(+$('azimuth').value), elevation = rad(+$('elevation').value);
  lighting.position.set(3*Math.cos(elevation)*Math.sin(azimuth),
    at.y+3*Math.sin(elevation),3*Math.cos(elevation)*Math.cos(azimuth));
  lighting.intensity = +$('key').value;
  fill.intensity = +$('fill').value;
  for (const id of ['azimuth','elevation','key','fill'])
    setRange(id,$(id).value,['azimuth','elevation'].includes(id) ? '°' : '');
  draw();
}

function syncLightBall() {
  const from = lighting.position.clone().sub(lighting.target.position).normalize();
  const screen = from.applyQuaternion(camera.quaternion.clone().invert());
  const x = (40+32*screen.x).toFixed(2), y = (40-32*screen.y).toFixed(2);
  $('light-ray').setAttribute('x2',x);
  $('light-ray').setAttribute('y2',y);
  $('light-marker').setAttribute('cx',x);
  $('light-marker').setAttribute('cy',y);
  $('light-ball').toggleAttribute('data-behind',screen.z<0);
}

function setupLightBall() {
  const ball = $('light-ball');
  let drag;
  function rotateLight(dx,dy) {
    const screen = camera.quaternion;
    const direction = lighting.position.clone().sub(lighting.target.position).normalize()
      .applyQuaternion(screen.clone().invert())
      .applyAxisAngle(new THREE.Vector3(0,1,0),dx*.024)
      .applyAxisAngle(new THREE.Vector3(1,0,0),dy*.024)
      .applyQuaternion(screen);
    // Preserve fractional movement while dragging; the precise controls display degrees.
    const azimuth = deg(Math.atan2(direction.x,direction.z));
    const elevation = clamp(deg(Math.asin(clamp(direction.y,-1,1))),-80,85);
    setRange('azimuth',azimuth.toFixed(1));
    setRange('elevation',elevation.toFixed(1));
    relight();
  }
  ball.addEventListener('pointerdown',event => {
    if (event.button!==0 || drag) return;
    ball.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId,x:event.clientX,y:event.clientY};
    ball.setAttribute('data-dragging','');
  });
  ball.addEventListener('pointermove',event => {
    if (drag?.id!==event.pointerId) return;
    rotateLight(event.clientX-drag.x,event.clientY-drag.y);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  ball.addEventListener('lostpointercapture',event => {
    if (drag?.id!==event.pointerId) return;
    drag = undefined;
    ball.removeAttribute('data-dragging');
  });
  ball.addEventListener('keydown',event => {
    const steps = {ArrowRight:[3,0],ArrowLeft:[-3,0],ArrowDown:[0,3],ArrowUp:[0,-3]};
    if (!steps[event.key]) return;
    event.preventDefault();
    rotateLight(...steps[event.key]);
  });
  $('light-reset').addEventListener('click',() => {
    $('azimuth').value = $('azimuth').defaultValue;
    $('elevation').value = $('elevation').defaultValue;
    relight();
  });
  ball.disabled = $('light-reset').disabled = false;
}

function choosePreset(name) {
  if (!rig || rotation.dragging || activeDrag) return;
  if (name==='rest' || (name==='stand' && !activeModel.bones && activeModel.key!=='gray')) rig.rest();
  else rig.preset(name);
  document.querySelectorAll('[data-pose]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.pose===name)));
  syncJointControls();
  draw();
}

function setupPoseLibrary() {
  const prefix = () => activeModel.key==='gray' ? 'sai2.pose.v1:' :
    'sai2.pose.v2:'+activeModel.key+(activeModel.mappingKey ?? '')+':';
  const list = $('saved-poses');
  const nameField = $('pose-name');
  const message = $('pose-message');
  function refresh(selected = list.value) {
    const namespace = activeModel && prefix();
    const names = rig ? Object.keys(localStorage).filter(key=>key.startsWith(namespace))
      .map(key=>key.slice(namespace.length)).sort((a,b)=>a.localeCompare(b,'zh-CN')) : [];
    list.replaceChildren(new Option(!rig ? '未绑定骨骼' : names.length ? '选择姿势' : '暂无已保存姿势',''),
      ...names.map(name=>new Option(name,name)));
    list.value = names.includes(selected) ? selected : '';
    syncButtons();
  }
  function syncButtons() {
    $('pose-load').disabled = $('pose-delete').disabled = !list.value;
  }
  function withStorage(action) {
    try { action(); }
    catch { message.value = '无法读写本机姿势库。'; }
  }
  list.addEventListener('change',syncButtons);
  $('pose-save').addEventListener('submit',event => {
    event.preventDefault();
    if (!rig || rotation.dragging || activeDrag) return;
    const name = nameField.value.trim();
    if (!name) { message.value = '请输入姿势名称。'; return; }
    withStorage(() => {
      const key = prefix()+name;
      if (localStorage.getItem(key)!==null && !window.confirm(`覆盖姿势「${name}」？`)) return;
      localStorage.setItem(key,JSON.stringify(rig.capturePose()));
      refresh(name);
      message.value = `已保存「${name}」。`;
    });
  });
  $('pose-load').addEventListener('click',() => withStorage(() => {
    if (!rig || !list.value || rotation.dragging || activeDrag) return;
    const data = localStorage.getItem(prefix()+list.value);
    if (!data || !rig.restorePose(JSON.parse(data))) { message.value = '姿势数据无效。'; return; }
    nameField.value = list.value;
    document.querySelectorAll('[data-pose]').forEach(b=>b.setAttribute('aria-pressed','false'));
    syncJointControls();
    draw();
    message.value = `已载入「${list.value}」。`;
  }));
  $('pose-delete').addEventListener('click',() => withStorage(() => {
    const name = list.value;
    if (!name || !window.confirm(`删除姿势「${name}」？`)) return;
    localStorage.removeItem(prefix()+name);
    if (nameField.value===name) nameField.value = '';
    refresh('');
    message.value = `已删除「${name}」。`;
  }));
  window.addEventListener('storage',event => {
    if (activeModel && (event.key===null || event.key.startsWith(prefix()))) withStorage(refresh);
  });
  return () => withStorage(() => {
    nameField.value = message.value = '';
    refresh('');
  });
}

function syncRigControls(pose='') {
  activeDrag = null;
  selectJoint('');
  for (const {button} of handles.splice(0)) button.remove();
  joints.clear();
  for (const option of $('limb').querySelectorAll('[data-shoulder]')) option.remove();
  if (rig) addHandles();
  for (const button of document.querySelectorAll('[data-pose]')) {
    button.disabled = !rig;
    if (button.dataset.pose==='rest') button.hidden = !activeModel.bones;
    button.setAttribute('aria-pressed',String(button.dataset.pose===pose));
  }
  for (const id of ['limb','handles','saved-poses','pose-name']) $(id).disabled = !rig;
  $('pose-save').querySelector('button').disabled = !rig;
  refreshPoses();
  draw();
}

function showMapping() {
  const {bones,mapping,issue,warning} = activeModel;
  const details = $('bone-map');
  details.hidden = !bones?.length;
  details.open = Boolean(bones?.length && !rig);
  const message = bones ? (!bones.length ? '没有蒙皮骨骼，仅可预览。' :
    issue || '已绑定人体骨骼。') : '';
  $('model-message').value = [message,warning].filter(Boolean).join(' ');
  $('bone-slots').replaceChildren(...(bones?.length ? boneSlots.map(([id,title])=>{
    const label = document.createElement('label');
    label.className = 'bone-slot';
    const select = document.createElement('select');
    select.dataset.bone = id;
    label.append(id.startsWith('shoulder') ? title+'（可选）' : title,select);
    select.append(new Option('未选择',''),...bones.map((bone,i)=>new Option((bone.name || '未命名')+' · '+(i+1),i)));
    const index = bones.indexOf(mapping[id]);
    select.value = index<0 ? '' : String(index);
    return label;
  }) : []));
}

function bindImported(entry, mapping) {
  const issue = mappingIssue(mapping);
  if (issue) throw Error(issue);
  if (entry.rig) entry.rig.rest();
  const next = new PoseRig(entry.model,{mapping,legacy:false,height:entry.height,extras:entry.extras});
  entry.rig = next;
  entry.mapping = mapping;
  entry.mappingKey = '-'+boneSlots.slice(0,requiredBoneSlots).map(([id])=>entry.bones.indexOf(mapping[id])).join('.');
  entry.issue = '';
}

function activateModel(entry,pose) {
  if (activeModel) scene.remove(activeModel.model);
  activeModel = entry;
  scene.add(entry.model);
  rig = entry.rig;
  $('model').value = entry === importedModel ? 'imported' : entry.key;
  syncRigControls(pose);
  showMapping();
  resetView();
}

function adaptHinzkaImport(entry) {
  const key = hinzkaKeys[entry.key];
  if (!key) return;
  // Keep trial-edition poses and mappings accessible for the exact same model.
  entry.key = key;
  entry.mapping.spine01 = entry.bones.find(bone => bone.name === 'J_Bip_C_UpperChest');
  const lit = new Map();
  const litMaterial = material => {
    if (!material.isMeshBasicMaterial) return material;
    if (!lit.has(material)) {
      const {name,color,map,side,alphaTest,transparent,depthWrite} = material;
      lit.set(material,new THREE.MeshStandardMaterial({
        name,color,map,side,alphaTest,transparent,depthWrite,roughness:.8,
      }));
    }
    return lit.get(material);
  };
  entry.model.traverse(node => {
    if (!node.isMesh) return;
    node.material = Array.isArray(node.material) ? node.material.map(litMaterial) : litMaterial(node.material);
  });
  for (const material of lit.keys()) material.dispose();
}

function setupModels(gray) {
  const picker = $('model');
  const open = $('import'), files = $('model-files');
  models.set('gray',gray);
  picker.append(...Object.entries(mannequins).map(([id,name])=>new Option(name,id)));
  picker.addEventListener('change',() => {
    if (rotation.dragging || activeDrag) {
      picker.value = activeModel === importedModel ? 'imported' : activeModel.key;
      return;
    }
    const key = picker.value;
    if (key==='imported') { activateModel(importedModel); return; }
    const cached = models.get(key);
    if (cached) {
      activateModel(cached);
      return;
    }
    const model = createMannequin(key);
    const height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;
    const entry = {key,model,rig:new PoseRig(model,{legacy:false,height})};
    models.set(key,entry);
    activateModel(entry,'stand');
  });
  open.addEventListener('click',()=>files.click());
  files.addEventListener('change',async () => {
    const selected = Array.from(files.files);
    files.value = '';
    if (!selected.length || activeDrag || rotation.dragging) return;
    picker.disabled = open.disabled = true;
    status.hidden = false;
    status.value = '正在载入模型…';
    try {
      const entry = await importModel(selected);
      adaptHinzkaImport(entry);
      if (entry.bones.length) {
        try {
          const stored = JSON.parse(localStorage.getItem('sai2.bones.v1:'+entry.key));
          if (Array.isArray(stored) && [requiredBoneSlots,boneSlots.length].includes(stored.length)) {
            const saved = {...entry.mapping,...Object.fromEntries(stored.map((index,i)=>[boneSlots[i][0],entry.bones[index]]))};
            if (!mappingIssue(saved)) entry.mapping = saved;
          }
        } catch {}
        try { bindImported(entry,entry.mapping); }
        catch (error) { entry.issue = error.message; }
      }
      const previous = importedModel;
      importedModel = entry;
      picker.querySelector('[value="imported"]')?.remove();
      picker.append(new Option(entry.name,'imported'));
      activateModel(entry,entry.rig?'rest':'');
      if (previous) {
        disposeModel(previous.model);
        previous.dispose();
      }
      status.hidden = true;
    } catch (error) {
      status.value = '导入失败：'+error.message;
    } finally {
      picker.disabled = open.disabled = false;
    }
  });
  $('apply-bones').addEventListener('click',() => {
    if (!activeModel.bones || activeDrag || rotation.dragging) return;
    const {bones,key} = activeModel;
    const mapping = Object.fromEntries(Array.from($('bone-slots').querySelectorAll('select'),s=>
      [s.dataset.bone,s.value==='' ? null : bones[Number(s.value)]]));
    try {
      bindImported(activeModel,mapping);
      rig = activeModel.rig;
      syncRigControls('rest');
      showMapping();
      try { localStorage.setItem('sai2.bones.v1:'+key,
        JSON.stringify(boneSlots.map(([id])=>bones.indexOf(mapping[id])))); }
      catch { $('model-message').value += ' 无法在本机保存映射。'; }
    } catch (error) {
      $('model-message').value = error.message;
      draw();
    }
  });
  picker.disabled = open.disabled = false;
}

function aim(event,plane) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(2*(event.clientX-rect.left)/rect.width-1,1-2*(event.clientY-rect.top)/rect.height);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(pointer,camera);
  return ray.ray.intersectPlane(plane,new THREE.Vector3());
}

function addHandles() {
  for (const [i,limb] of rig.chains.entries()) {
    const prefix = i%2 ? '右' : '左';
    joints.set(String(i), {id:String(i),kind:'end',label:limb.label,bone:limb.end,limb,joint:limb,mark:prefix});
    joints.set('p'+i, {id:'p'+i,kind:'pole',label:prefix+(limb.leg?'膝':'肘'),bone:limb.lower,limb,mark:''});
    if (limb.shoulder) {
      const [id,label] = shoulderSlots[i];
      joints.set(id,{id,kind:'shoulder',label,bone:limb.upper,limb,mark:'↕'});
      const option = new Option(label,id);
      option.dataset.shoulder = '';
      $('limb').append(option);
    }
  }
  for (const [id,label] of [['pelvis','胯部'],['torso','躯干'],['head','头部']]) {
    const joint = rig.body[id];
    joints.set(id,{id,kind:id,label,bone:joint.bone,joint,mark:''});
  }
  for (const {id,kind,label,bone,limb,mark} of joints.values()) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'handle '+(kind === 'end' ? (limb.leg?'foot':'hand') : 'pivot '+kind);
    handle.textContent = mark;
    handle.setAttribute('aria-label',label);
    handle.title = label;
    const select = () => selectJoint(id);
    handle.addEventListener('click',select);
    if (kind === 'shoulder') {
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || activeDrag || rotation.dragging) return;
        handle.setPointerCapture(e.pointerId);
        activeDrag = {handle,pointer:e.pointerId,y:e.clientY,angle:limb.shoulder.angle};
        select();
      });
      handle.addEventListener('pointermove', e => {
        if (activeDrag?.handle !== handle || activeDrag.pointer !== e.pointerId) return;
        liftShoulder(limb,activeDrag.angle+(activeDrag.y-e.clientY)*240/Math.max(height,240));
      });
      handle.addEventListener('keydown', e => {
        if (e.key!=='ArrowUp' && e.key!=='ArrowDown') return;
        e.preventDefault();
        select();
        liftShoulder(limb,limb.shoulder.angle+(e.key==='ArrowUp'?1:-1)*(e.shiftKey?5:1));
      });
    }
    if (kind === 'end') handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || activeDrag) return;
      handle.setPointerCapture(e.pointerId);
      const end = limb.end.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()),end);
      const hit = aim(e,plane);
      if (!hit) return;
      activeDrag = {handle,plane,offset:end.sub(hit),pointer:e.pointerId};
      select();
    });
    handle.addEventListener('pointermove', e => {
      if (kind !== 'end') return;
      if (activeDrag?.handle !== handle || activeDrag.pointer !== e.pointerId) return;
      const hit = aim(e,activeDrag.plane);
      if (!hit) return;
      limb.target.copy(hit.add(activeDrag.offset));
      rig.update();
      draw();
    });
    handle.addEventListener('lostpointercapture', () => {
      if (activeDrag?.handle === handle) activeDrag = null;
    });
    if (kind === 'end') handle.addEventListener('keydown',e => {
      const offsets = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
      if (!(e.key in offsets)) return;
      e.preventDefault();
      const [x,y] = offsets[e.key], step = e.shiftKey?.04:.01;
      select();
      limb.target.add(new THREE.Vector3(x*step,y*step,0).applyQuaternion(camera.quaternion));
      rig.update();
      draw();
    });
    viewport.append(handle);
    handles.push({button:handle,bone,id});
  }
}

function exportPng() {
  const button = $('export');
  const message = $('export-status');
  const scale = Number($('export-resolution').value)/Math.max(width,height);
  const exportWidth = Math.max(1,Math.round(width*scale));
  const exportHeight = Math.max(1,Math.round(height*scale));
  const gl = renderer.getContext();
  const fail = () => {
    button.disabled = false;
    message.value = 'PNG 导出失败。请降低分辨率后重试。';
    message.hidden = false;
  };
  const [maxWidth,maxHeight] = gl.getParameter(gl.MAX_VIEWPORT_DIMS) ?? [0,0];
  const maxBuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  if (gl.isContextLost() || exportWidth > Math.min(maxWidth,maxBuffer) ||
      exportHeight > Math.min(maxHeight,maxBuffer)) {
    fail();
    return;
  }
  const helper = rotation.getHelper();
  const visible = helper.visible;
  const pixelRatio = renderer.getPixelRatio();
  message.hidden = true;
  button.disabled = true;
  try {
    renderer.setDrawingBufferSize(exportWidth,exportHeight,1);
    if (gl.drawingBufferWidth !== exportWidth || gl.drawingBufferHeight !== exportHeight) {
      fail();
      return;
    }
    helper.visible = false;
    renderer.render(scene,camera);
    // toBlob snapshots the export buffer before the preview size is restored.
    renderer.domElement.toBlob(blob => {
      if (!blob) {
        fail();
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sai2-pose.png';
      link.click();
      button.disabled = false;
      setTimeout(() => URL.revokeObjectURL(url),60000);
    },'image/png');
  } catch {
    fail();
  } finally {
    helper.visible = visible;
    renderer.setDrawingBufferSize(width,height,pixelRatio);
    draw();
  }
}

async function start() {
  try {
    renderer = new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setClearColor(0,0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    viewport.prepend(renderer.domElement);
    const asset = await new GLTFLoader().loadAsync('./mannequin.glb');
    const clay = new THREE.MeshStandardMaterial({color:0xaaa598,roughness:.74});
    asset.scene.traverse(node => {
      if (node.isMesh) {
        node.material = clay;
        node.frustumCulled = false;
      }
    });
    const gray = {key:'gray',model:asset.scene,rig:new PoseRig(asset.scene)};
    resize();
    useCamera('persp',true);
    relight();
    new ResizeObserver(resize).observe(viewport);
    document.querySelectorAll('[data-pose]').forEach(b => b.addEventListener('click',() => choosePreset(b.dataset.pose)));
    document.querySelectorAll('[data-camera]').forEach(b => b.addEventListener('click',() => {
      if (b.dataset.camera!==mode) useCamera(b.dataset.camera);
    }));
    for (const id of ['azimuth','elevation','key','fill']) $(id).addEventListener('input',relight);
    setupLightBall();
    $('limb').addEventListener('change',() => selectJoint($('limb').value));
    for (const [i] of jointRanges.hand.entries()) {
      const id = 'joint-'+i;
      $(id).addEventListener('input',() => {
        const value = +$(id).value;
        selection.joint.angles[i] = value;
        setRange(id,value);
        rig.update();
        draw();
      });
    }
    $('reset-joint').addEventListener('click',() => {
      if (!selection) return;
      if (selection.joint) selection.joint.angles.fill(0);
      else if (selection.kind === 'shoulder') { liftShoulder(selection.limb,0); return; }
      else selection.limb.angle = 0;
      syncJointControls();
      rig.update();
      draw();
    });
    const shoulderLift = $('shoulder-lift');
    [shoulderLift.min,shoulderLift.max] = shoulderRange;
    shoulderLift.addEventListener('input',() => {
      if (selection?.kind === 'shoulder') liftShoulder(selection.limb,+shoulderLift.value);
    });
    $('pole').addEventListener('input',() => {
      selection.limb.angle = +$('pole').value;
      setRange('pole',selection.limb.angle);
      rig.update();
      draw();
    });
    $('handles').addEventListener('change',draw);
    $('fit').addEventListener('click',resetView);
    $('export').addEventListener('click',exportPng);
    refreshPoses = setupPoseLibrary();
    setupModels(gray);
    activateModel(gray,'stand');
    $('export').disabled = false;
    status.hidden = true;
  } catch (error) {
    status.value = '3D 初始化失败：'+error.message;
    console.error(error);
  }
}

start();
