import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const testLocalModels = process.argv.includes('--test-local-models');
const buildName = 'pose-studio';
const root = resolve('../build',buildName,'web');
const output = resolve('../validation',testLocalModels ? 'pose-studio-local-models' : buildName);
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css',
              '.svg':'image/svg+xml','.glb':'model/gltf-binary'};

function splitGlb(bytes) {
  const end = 20 + bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8',20,end));
  return {json, binary:bytes.subarray(end+8)};
}

function packGlb(json,binary) {
  const raw = Buffer.from(JSON.stringify(json));
  const data = Buffer.alloc(Math.ceil(raw.length/4)*4,32);
  raw.copy(data);
  const head = Buffer.alloc(20);
  head.write('glTF');
  head.writeUInt32LE(2,4);
  head.writeUInt32LE(28+data.length+binary.length,8);
  head.writeUInt32LE(data.length,12);
  head.write('JSON',16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binary.length);
  binHead.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([head,data,binHead,binary]);
}

const previewFbx = Buffer.from([
  '; FBX 7.4.0 project file',
  'FBXHeaderExtension:  {',
  '\tFBXHeaderVersion: 1003',
  '\tFBXVersion: 7400',
  '}',
  'Objects:  {',
  '\tGeometry: 100, "Geometry::Triangle", "Mesh" {',
  '\t\tVertices: *9 {',
  '\t\t\ta: -1,0,0,1,0,0,0,2,0',
  '\t\t}',
  '\t\tPolygonVertexIndex: *3 {',
  '\t\t\ta: 0,1,-3',
  '\t\t}',
  '\t}',
  '\tModel: 200, "Model::Triangle", "Mesh" {',
  '\t\tVersion: 232',
  '\t}',
  '}',
  'Connections:  {',
  '\tC: "OO",100,200',
  '\tC: "OO",200,0',
  '}',
].join('\n'));
const server = createServer(async (req,res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const f = resolve(root,'.'+new URL(req.url,'http://127.0.0.1').pathname);
  try {
    if (!f.startsWith(root+sep)) throw Error();
    res.setHeader('content-type',mime[extname(f)] ?? 'application/octet-stream');
    res.end(await readFile(f));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await mkdir(output,{recursive:true});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({channel:'msedge',headless:true,args:[
    '--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking'
  ]});
  const results = [];
  for (const [name,viewport] of [['desktop',{width:1100,height:750}],['narrow',{width:425,height:690}]]) {
    const page = await browser.newPage({viewport,deviceScaleFactor:1});
    const errors = [];
    page.on('pageerror',e => errors.push(String(e)));
    page.on('console',msg => {
      if (msg.type()==='error') errors.push(msg.text()+' '+msg.location().url);
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
    try {
      await page.waitForFunction(() => !document.querySelector('#export').disabled, null, {timeout:15000});
    } catch (error) {
      throw Error((await page.locator('#status').textContent())+' '+errors.join('; '),{cause:error});
    }
    const pixels = async (png = null) => {
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      if (errors.length) throw Error(errors.join('; '));
      return page.locator('canvas').evaluate(async (c,png) => {
        const small = document.createElement('canvas');
        small.width = 144;
        small.height = 144;
        const ctx = small.getContext('2d');
        const image = png ? await createImageBitmap(new Blob(
          [Uint8Array.from(atob(png),char => char.charCodeAt(0))],{type:'image/png'}
        )) : c;
        ctx.drawImage(image,0,0,144,144);
        if (png) image.close();
        const data = ctx.getImageData(0,0,144,144).data;
        let count=0,x0=144,y0=144,x1=0,y1=0,gray=0,hash=0;
        for (let i=0;i<data.length;i+=4) {
          hash = (Math.imul(hash,16777619) + data[i] + data[i+1]*7 + data[i+2]*13 + data[i+3]*17) >>> 0;
          if (data[i+3]<100) continue;
          const x = (i/4)%144, y = Math.floor(i/576);
          x0=Math.min(x,x0); y0=Math.min(y,y0); x1=Math.max(x,x1); y1=Math.max(y,y1);
          count++;
          gray += data[i]+data[i+1]+data[i+2];
        }
        const cornerAlpha = [3,575,data.length-573,data.length-1].map(i => data[i]);
        return {count,bounds:[x0,y0,x1,y1],gray,hash,cornerAlpha};
      },png?.toString('base64'));
    };
    const resolution = page.locator('#export-resolution');
    assert.equal(await resolution.inputValue(),'2048');
    const exportPng = async (path,edge) => {
      const canvas = page.locator('#viewport canvas');
      const dimensions = () => canvas.evaluate(c => [c.clientWidth,c.clientHeight,c.width,c.height]);
      const before = await dimensions();
      const download = page.waitForEvent('download');
      await page.locator('#export').click();
      await (await download).saveAs(path);
      const png = await readFile(path);
      assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],
        before.slice(0,2).map(length => Math.round(length*edge/Math.max(before[0],before[1]))));
      assert.deepEqual(await dimensions(),before);
      return png;
    };
    const checkExportPixels = async (png,preview) => {
      const rendered = await pixels(png);
      assert(rendered.count>500,JSON.stringify(rendered));
      assert.deepEqual(rendered.cornerAlpha,[0,0,0,0]);
      assert(rendered.bounds.every((value,i) => Math.abs(value-preview.bounds[i])<=3),
        JSON.stringify({preview:preview.bounds,export:rendered.bounds}));
    };
    const start = await pixels();
    assert(start.count>500 && start.count<10000,JSON.stringify(start));
    assert(start.bounds[0]>1 && start.bounds[1]>1 && start.bounds[2]<142 && start.bounds[3]<142,JSON.stringify(start));
    assert.equal(await page.locator('img').evaluateAll(list=>list.every(i=>i.complete&&i.naturalWidth>0)),true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth),true);
    await page.screenshot({path:resolve(output,name+'.png')});
    const checkShoulders = async tag => {
      const left = page.getByRole('button',{name:'左肩',exact:true});
      const right = page.getByRole('button',{name:'右肩',exact:true});
      const y = locator => locator.evaluate(el=>parseFloat(el.style.top));
      const before = await pixels();
      const leftY = await y(left), rightY = await y(right);
      const hit = await left.boundingBox();
      assert(hit,tag+': left shoulder not visible');
      const x = hit.x+hit.width/2, top = hit.y+hit.height/2;
      await page.mouse.move(x,top);
      await page.mouse.down();
      await page.mouse.move(x,top-45,{steps:9});
      await page.mouse.up();
      const raised = await pixels();
      assert(await y(left)<leftY-4,tag+': left shoulder did not rise');
      assert(Math.abs(await y(right)-rightY)<.1,tag+': right shoulder moved as well');
      assert.notEqual(raised.hash,before.hash,tag+': shoulder did not deform mesh');
      assert(+(await page.locator('#shoulder-lift').inputValue())>0);
      await page.screenshot({path:resolve(output,`${name}-${tag}-shoulder.png`)});
      await page.locator('#reset-joint').click();
      assert.equal((await pixels()).hash,before.hash);
      await page.locator('#limb').selectOption('shoulderR');
      await page.locator('#shoulder-lift').evaluate(input => {
        input.value = '-18';
        input.dispatchEvent(new Event('input'));
      });
      await pixels();
      assert(await y(right)>rightY+2,tag+': right shoulder did not lower');
      await page.locator('#reset-joint').click();
      await page.keyboard.press('Escape');
      assert.equal((await pixels()).hash,before.hash);
    };
    await checkShoulders('gray');
    if (testLocalModels) {
      const picker = page.locator('#model');
      const snapshots = [];
      for (const id of ['hinzka-male','hinzka-female']) {
        const file = id+'.vrm';
        await page.locator('#model-files').setInputFiles(resolve('../downloads/hinzka',file));
        await page.waitForFunction(() => !document.querySelector('#model').disabled);
        assert.equal(await picker.inputValue(),'imported',await page.locator('#status').textContent());
        assert.equal(await picker.locator('option:checked').textContent(),file);
        assert.equal(await page.locator('#status').isHidden(),true);
        assert.match(await page.locator('#model-message').textContent(),/已绑定/);
        assert.match(await page.locator('[data-bone=spine01] option:checked').textContent(),/^J_Bip_C_UpperChest /);
        const rest = await pixels();
        assert(rest.count>500 && rest.count<10000,JSON.stringify(rest));
        assert(rest.bounds.every(n=>n>1 && n<142),JSON.stringify(rest));
        await page.screenshot({path:resolve(output,`${name}-${id}.png`)});
        const wrists = async () => {
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          return page.locator('.handle.hand').evaluateAll(handles =>
            handles.map(({style})=>[parseFloat(style.left),parseFloat(style.top)]));
        };
        const tPose = await wrists();
        const wristPoses = {};
        for (const preset of ['stand','walk','run','sit','crouch','reach']) {
          await page.locator('[data-pose='+preset+']').click();
          wristPoses[preset] = await wrists();
          if (preset==='stand' || preset==='reach') {
            await page.screenshot({path:resolve(output,`${name}-${id}-${preset}.png`)});
          }
        }
        const {stand,reach} = wristPoses;
        const span = points => Math.abs(points[0][0]-points[1][0]);
        const details = JSON.stringify({name,id,tPose,wristPoses});
        assert(stand.every(([,y],i)=>y>tPose[i][1]+45),details);
        assert(span(stand)<span(tPose)*.65,details);
        assert(reach[0][1]<stand[0][1]-50 && reach[0][1]<reach[1][1]-50,details);
        assert.equal(new Set(Object.values(wristPoses).map(points=>JSON.stringify(points))).size,6,details);
        await checkShoulders(id);
        await page.locator('#limb').selectOption('0');
        assert.equal(await page.locator('#joint-0').inputValue(),'-16');
        assert.equal(await page.locator('#joint-2').inputValue(),'24');
        await page.locator('[data-pose=rest]').click();
        assert.deepEqual(await wrists(),tPose);
        await page.locator('#limb').selectOption('0');
        assert.equal(await page.locator('#joint-2').inputValue(),'0');
        await page.locator('[data-pose="reach"]').click();
        const posed = await pixels();
        assert.notEqual(posed.hash,rest.hash);
        assert(posed.bounds.every(n=>n>1 && n<142),JSON.stringify({name,id,posed}));
        await page.locator('#key').evaluate(input => {
          input.value = input.value === input.min ? input.max : input.min;
          input.dispatchEvent(new Event('input'));
        });
        const lit = await pixels();
        assert.notEqual(lit.hash,posed.hash);
        snapshots.push({id,rest,posed,lit,wristPoses});
      }
      assert.notEqual(snapshots[0].rest.hash,snapshots[1].rest.hash);
      await page.keyboard.press('Escape');
      const preview = await pixels();
      await resolution.selectOption('4096');
      await checkExportPixels(await exportPng(resolve(output,name+'-4096.png'),4096),preview);
      results.push({name,snapshots});
      await page.close();
      continue;
    }
    if (name==='desktop') {
      const rigChecks = await page.evaluate(async () => {
        const {Quaternion,Vector3} = await import('three');
        const {GLTFLoader} = await import('./vendor/loaders/GLTFLoader.js');
        const {PoseRig,jointWorldRotation,setJointWorldRotation} = await import('./rig.js');
        const {importModel} = await import('./model-import.js');
        const {scene} = await new GLTFLoader().loadAsync('./mannequin.glb');
        const rig = new PoseRig(scene);
        const feet = rig.chains.filter(c=>c.leg);
        const neutral = feet.map(c=>c.neutralWorld.clone());
        rig.preset('crouch');
        const feetFollowShins = feet.every((c,i)=>neutral[i].angleTo(c.neutralWorld)>.15);
        const fullPitch = feet.every(c => {
          c.angles = [170,15,20];
          rig.update();
          const before = jointWorldRotation(c);
          const ankle = c.end.getWorldPosition(new Vector3());
          const after = before.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-Math.PI/9));
          setJointWorldRotation(c,after);
          rig.update();
          return Math.abs(c.angles[0]+170)<.001 && Math.abs(c.angles[1]-15)<.001 &&
            Math.abs(c.angles[2]-20)<.001 && jointWorldRotation(c).angleTo(after)<.001 &&
            c.end.getWorldPosition(new Vector3()).distanceTo(ankle)<.001;
        });
        const {head,torso} = rig.body;
        const headBefore = head.bone.getWorldQuaternion(new Quaternion());
        torso.angles[2] = 28;
        rig.update();
        const headAfter = head.bone.getWorldQuaternion(new Quaternion());
        const torsoAfter = torso.bone.getWorldQuaternion(new Quaternion());
        const headFollowsTorso = Math.abs(headBefore.angleTo(headAfter)-28*Math.PI/180)<.001;
        head.angles = [20,-25,35];
        rig.update();
        const headTurnsIndependently = headAfter.angleTo(head.bone.getWorldQuaternion(new Quaternion()))>.3 &&
          torsoAfter.angleTo(torso.bone.getWorldQuaternion(new Quaternion()))<.001;
        const hands = rig.chains.filter(c=>!c.leg);
        const fullPalmRoll = hands.every(c => {
          c.angles = [30,-20,170];
          rig.update();
          const after = jointWorldRotation(c).multiply(new Quaternion()
            .setFromAxisAngle(new Vector3(0,1,0),(c.right?-1:1)*Math.PI/9));
          setJointWorldRotation(c,after);
          rig.update();
          return Math.abs(c.angles[2]+170)<.001 && Math.abs(c.angles[0]-30)<.001 &&
            Math.abs(c.angles[1]+20)<.001 && jointWorldRotation(c).angleTo(after)<.001;
        });
        const before = rig.capturePose();
        rig.body.pelvis.angles = [10,25,-12];
        rig.update();
        const moved = rig.capturePose();
        const pelvisRotates = jointWorldRotation(rig.body.pelvis).angleTo(new Quaternion())>.3 &&
          JSON.stringify(before.limbs)===JSON.stringify(moved.limbs);
        rig.preset('stand');
        const restored = rig.restorePose(moved) && JSON.stringify(rig.capturePose())===JSON.stringify(moved);
        const invalid = structuredClone(moved);
        invalid.limbs[0].target[2] = Infinity;
        const rejected = !rig.restorePose(invalid) && JSON.stringify(rig.capturePose())===JSON.stringify(moved);
        const file = new File([await (await fetch('./mannequin.glb')).blob()],'fixture.glb');
        const [entry,rotated] = await Promise.all([importModel([file]),importModel([file])]);
        const yaw = new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/2);
        rotated.model.quaternion.copy(yaw);
        rotated.model.position.applyQuaternion(yaw);
        const make = ({model,mapping,height,extras}) => new PoseRig(model,{mapping,height,extras,legacy:false});
        const imported = make(entry), facingSide = make(rotated);
        const endPositions = actor => actor.chains.map(c=>c.end.getWorldPosition(new Vector3()));
        const bindPositions = endPositions(imported);
        imported.preset('stand');
        const standingHands = endPositions(imported).slice(0,2);
        const importedArmsLower = standingHands.every((hand,i)=>{
          const arm = imported.chains[i];
          return arm.upper.getWorldPosition(new Vector3()).y-hand.y>(arm.l1+arm.l2)*.85;
        });
        const importUsesOwnFacing = ['stand','walk','run','sit','crouch','reach'].every(preset => {
          imported.preset(preset);
          facingSide.preset(preset);
          const positions = endPositions(imported);
          return endPositions(facingSide).every((end,i)=>end.distanceTo(positions[i].applyQuaternion(yaw))<.001);
        });
        const importedHandsReach = endPositions(imported)[0].y>standingHands[0].y+.25;
        imported.rest();
        const importedRestored = endPositions(imported).every((end,i)=>end.distanceTo(bindPositions[i])<.001);
        imported.preset('reach');
        const beforeShoulder = imported.chains.map(c=>c.upper.getWorldPosition(new Vector3()));
        const handTarget = imported.chains[0].target.clone();
        imported.chains[0].shoulder.angle = 20;
        imported.update();
        const shoulderRigMoves = imported.chains[0].upper.getWorldPosition(new Vector3()).y>beforeShoulder[0].y+.01
          && imported.chains[0].target.equals(handTarget);
        const liftedPose = imported.capturePose();
        imported.rest();
        const shoulderRestores = imported.restorePose(liftedPose) && imported.chains[0].shoulder.angle===20;
        delete liftedPose.shoulders;
        const supportsOldPoses = imported.restorePose(liftedPose) && imported.chains[0].shoulder.angle===0;
        return {feetFollowShins,fullPitch,headFollowsTorso,headTurnsIndependently,fullPalmRoll,pelvisRotates,
          restored,rejected,importedArmsLower,importUsesOwnFacing,importedHandsReach,importedRestored,
          shoulderRigMoves,shoulderRestores,supportsOldPoses};
      });
      for (const [check,passed] of Object.entries(rigChecks)) assert(passed,check);
    }
    const hashes = new Set([start.hash]);
    for (const preset of ['walk','run','sit','crouch','reach','stand']) {
      await page.locator('[data-pose='+preset+']').click();
      const sample = await pixels();
      assert(sample.count>350 && sample.bounds[0]>0 && sample.bounds[1]>0 &&
        sample.bounds[2]<143 && sample.bounds[3]<143,JSON.stringify({preset,...sample}));
      hashes.add(sample.hash);
    }
    assert.equal(hashes.size,6);
    const joint = page.locator('#limb');
    const setAngle = (axis,value) => page.locator('#joint-'+axis).evaluate((input,value) => {
      input.value = value;
      input.dispatchEvent(new Event('input',{bubbles:true}));
    },value);
    const assertAngle = async (axis,value) => {
      assert.equal(await page.locator('#joint-'+axis).inputValue(),String(value));
    };
    for (const [i,label] of ['左手','右手','左脚','右脚'].entries()) {
      await joint.selectOption(String(i));
      assert.equal(await page.locator('#joint-0-label').textContent(),i<2 ? '手腕弯伸' : '脚尖抬压');
      const handle = page.getByRole('button',{name:label,exact:true});
      const initial = await handle.boundingBox();
      let previous = await pixels();
      for (const [axis,value] of [30,-25,-35].entries()) {
        await setAngle(axis,value);
        await assertAngle(axis,value);
        const next = await pixels();
        assert.notEqual(previous.hash,next.hash,`${name} ${label} axis ${axis}`);
        previous = next;
      }
      const rotated = await handle.boundingBox();
      assert(Math.abs(initial.x-rotated.x)<.2 && Math.abs(initial.y-rotated.y)<.2);
    }
    for (const id of ['2','3']) {
      await joint.selectOption(id);
      const pitch = page.locator('#joint-0');
      assert.equal(await pitch.getAttribute('min'),'-180');
      assert.equal(await pitch.getAttribute('max'),'180');
      await setAngle(0,120);
      const pitched = await pixels();
      await assertAngle(0,120);
      await setAngle(0,-120);
      await assertAngle(0,-120);
      assert.notEqual((await pixels()).hash,pitched.hash);
    }
    for (const [id,label] of [['pelvis','胯部左右侧倾'],['torso','躯干左右侧倾'],['head','头部左右侧倾']]) {
      await joint.selectOption(id);
      assert.equal(await page.locator('#joint-2-label').textContent(),label);
      for (const axis of [0,1,2]) {
        const previous = await pixels();
        await setAngle(axis,24);
        await assertAngle(axis,24);
        assert.notEqual((await pixels()).hash,previous.hash,`${name}: ${id} axis ${axis}`);
      }
      await page.locator('#reset-joint').click();
      for (const axis of [0,1,2]) await assertAngle(axis,0);
    }
    await joint.selectOption('0');
    await assertAngle(0,30);
    await page.locator('#joint-1').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,name+'-joint-angles.png')});
    await page.locator('#reset-joint').click();
    await assertAngle(0,0);
    await joint.selectOption('1');
    await assertAngle(0,30);
    await page.locator('[data-pose=stand]').click();
    await assertAngle(0,0);
    await page.keyboard.press('Escape');
    assert.equal(await joint.inputValue(),'');
    assert.equal((await pixels()).hash,start.hash);
    const dragRing = async (label, key, inputId, axisName) => {
      const handle = page.getByRole('button',{name:label,exact:true});
      await handle.click();
      assert.equal(await joint.inputValue(),key);
      assert.equal(await page.locator('#viewport button[aria-pressed=true]').count(),1);
      await pixels();
      const b = await handle.boundingBox();
      const center = [b.x+b.width/2,b.y+b.height/2];
      const canvas = page.locator('canvas');
      const channel = 'XYZ'.indexOf(axisName);
      // Locate rendered ring pixels, then use the actual hover hit to resolve overlaps.
      const candidates = await canvas.evaluate((canvas,{channel,center}) => {
        const rect = canvas.getBoundingClientRect();
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas,0,0);
        const data = ctx.getImageData(0,0,copy.width,copy.height).data;
        const points = [];
        for (let y=0;y<copy.height;y++) for (let x=0;x<copy.width;x++) {
          const offset = (y*copy.width+x)*4;
          const color = data[offset+channel];
          const contrast = color - Math.max(data[offset+(channel+1)%3],data[offset+(channel+2)%3]);
          if (contrast<45 || data[offset+3]<100) continue;
          const px = rect.x+(x+.5)*rect.width/copy.width;
          const py = rect.y+(y+.5)*rect.height/copy.height;
          const radius = Math.hypot(px-center[0],py-center[1]);
          if (radius<15 || radius>100 || document.elementFromPoint(px,py)!==canvas) continue;
          points.push({px,py,radius,contrast});
        }
        const distinct = [];
        for (const p of points.sort((a,b)=>b.contrast-a.contrast || b.radius-a.radius)) {
          if (distinct.every(q=>Math.hypot(p.px-q.px,p.py-q.py)>4)) distinct.push(p);
        }
        return distinct;
      },{channel,center});
      assert(candidates.length>0,`${name}: no visible rotation ring for ${label}`);
      let hit;
      for (const candidate of candidates) {
        await page.mouse.move(candidate.px,candidate.py);
        if (await canvas.getAttribute('data-rotation-axis')===axisName) {
          hit = candidate;
          break;
        }
      }
      assert(hit,`${name}: ${label} axis ${axisName} was not pickable`);
      const input = page.locator('#'+inputId);
      const previous = await input.inputValue();
      const {px,py} = hit;
      await page.mouse.down();
      assert.equal(await canvas.getAttribute('data-rotating'),'');
      await page.mouse.move(px+24,py,{steps:5});
      if (await input.inputValue()===previous) await page.mouse.move(px,py+24,{steps:5});
      await page.mouse.up();
      const value = await input.inputValue();
      assert.notEqual(value,previous,`${name}: ${label} ring did not change ${inputId}`);
      return value;
    };
    const wristHandle = page.getByRole('button',{name:'左手',exact:true});
    const wristBeforeRing = await wristHandle.boundingBox();
    const wristAngle = await dragRing('左手','0','joint-1','X');
    const wristAfterRing = await wristHandle.boundingBox();
    assert(Math.hypot(wristAfterRing.x-wristBeforeRing.x,wristAfterRing.y-wristBeforeRing.y)<.2);
    const poleAngle = await dragRing('右肘','p1','pole','Z');
    const torsoAngle = await dragRing('躯干','torso','joint-2','Z');
    const headAngle = await dragRing('头部','head','joint-1','Y');
    await page.locator('#joint-2').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,name+'-head-angle.png')});
    const pelvisAngle = await dragRing('胯部','pelvis','joint-1','Y');
    await page.locator('[data-pose=stand]').click();
    const footAngle = await dragRing('左脚','2','joint-0','X');
    await page.locator('[data-pose=stand]').click();
    await joint.selectOption('0');
    await page.locator('#reset-joint').click();
    await assertAngle(0,0);
    await joint.selectOption('0');
    await setAngle(0,25);
    const posed = await pixels();
    const wrist = page.getByRole('button',{name:'左手',exact:true});
    const b = await wrist.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
    await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+20,b.y+b.height/2-65,{steps:8});
    await page.mouse.up();
    assert.equal(await joint.inputValue(),'0');
    await assertAngle(0,25);
    const moved = await pixels();
    assert.notEqual(posed.hash,moved.hash);
    const after = await wrist.boundingBox();
    assert(Math.abs(after.y-b.y)>12);
    const foot = page.getByRole('button',{name:'右脚',exact:true});
    const f = await foot.boundingBox();
    await page.mouse.move(f.x+f.width/2,f.y+f.height/2);
    await page.mouse.down();
    await page.mouse.move(f.x+f.width/2-28,f.y+f.height/2-38,{steps:8});
    await page.mouse.up();
    assert.equal(await joint.inputValue(),'3');
    const stepped = await pixels();
    assert.notEqual(moved.hash,stepped.hash);
    assert(Math.abs((await foot.boundingBox()).y-f.y)>12);
    await page.locator('#azimuth').evaluate(el => {
      el.value = -145;
      el.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const lit = await pixels();
    assert.notEqual(stepped.gray,lit.gray);
    const ball = page.locator('#light-ball');
    const marker = page.locator('#light-marker');
    const lightBefore = await page.locator('#azimuth').inputValue();
    const markerBefore = await marker.getAttribute('cx');
    const bLight = await ball.boundingBox();
    await page.mouse.move(bLight.x+bLight.width/2,bLight.y+bLight.height/2);
    await page.mouse.down();
    await page.mouse.move(bLight.x+bLight.width/2+54,bLight.y+bLight.height/2+25,{steps:10});
    await page.mouse.up();
    const ballLit = await pixels();
    assert.notEqual(ballLit.gray,lit.gray);
    assert.deepEqual(ballLit.bounds,lit.bounds);
    assert.notEqual(await marker.getAttribute('cx'),markerBefore);
    assert.notEqual(await page.locator('#azimuth').inputValue(),lightBefore);
    await page.locator('#light-reset').click();
    assert.equal(await page.locator('#azimuth').inputValue(),'38');
    assert.equal(await page.locator('#elevation').inputValue(),'44');
    await page.locator('[data-camera=ortho]').click();
    const ortho = await pixels();
    assert.notEqual(lit.hash,ortho.hash);
    const c = await page.locator('canvas').boundingBox();
    await page.mouse.move(c.x+c.width*.23,c.y+c.height*.44);
    await page.mouse.down();
    await page.mouse.move(c.x+c.width*.33,c.y+c.height*.48,{steps:8});
    await page.mouse.up();
    const orbited = await pixels();
    assert.notEqual(ortho.hash,orbited.hash);
    await joint.selectOption('3');
    await pixels();
    const withSelection = await exportPng(resolve(output,name+'-export.png'),2048);
    await page.keyboard.press('Escape');
    const preview = await pixels();
    const withoutSelection = await exportPng(resolve(output,name+'-export-unselected.png'),2048);
    assert(withSelection.equals(withoutSelection),`${name}: rotation control leaked into PNG`);
    await checkExportPixels(withoutSelection,preview);
    const edge = name==='desktop' ? 4096 : 1024;
    await resolution.selectOption(String(edge));
    await checkExportPixels(await exportPng(resolve(output,name+'-'+edge+'.png'),edge),preview);
    await page.locator('[data-camera=persp]').click();
    await page.locator('#fit').click();
    await page.locator('[data-pose=crouch]').click();
    await joint.selectOption('pelvis');
    await setAngle(1,28);
    await joint.selectOption('head');
    await setAngle(2,-16);
    await joint.selectOption('0');
    await setAngle(2,145);
    await assertAngle(2,145);
    await page.keyboard.press('Escape');
    const savedPose = await pixels();
    const poseName = page.locator('#pose-name');
    const poseList = page.locator('#saved-poses');
    const savePose = page.getByRole('button',{name:'保存当前姿势'});
    const poseLabel = '坐姿参考 01';
    await poseName.fill('  '+poseLabel+'  ');
    await savePose.click();
    assert.equal(await poseList.inputValue(),poseLabel);
    await page.screenshot({path:resolve(output,name+'-pose-library.png')});
    await page.locator('[data-pose=stand]').click();
    page.once('dialog',dialog=>dialog.dismiss());
    await savePose.click();
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#export').disabled);
    await poseList.selectOption(poseLabel);
    await page.locator('#pose-load').click();
    assert.equal((await pixels()).hash,savedPose.hash,`${name}: saved pose changed after restart`);
    await joint.selectOption('pelvis');
    await assertAngle(1,28);
    await joint.selectOption('0');
    await assertAngle(2,145);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#pose-delete').click();
    assert.equal(await poseList.locator('option').count(),1);
    const picker = page.locator('#model');
    const seen = new Set();
    await page.locator('#handles').uncheck();
    for (const id of ['boy','man','child','girl','woman']) {
      await picker.selectOption(id);
      const neutral = await pixels();
      assert(neutral.count>300 && neutral.count<12000,id+': '+JSON.stringify(neutral));
      assert(neutral.bounds[1]>1 && neutral.bounds[3]<142,id+': '+JSON.stringify(neutral));
      seen.add(neutral.hash);
      await page.screenshot({path:resolve(output,name+'-'+id+'.png')});
      await page.locator('[data-pose=reach]').click();
      assert.notEqual((await pixels()).hash,neutral.hash);
    }
    assert.equal(seen.size,5);
    if (name==='desktop') {
      await poseName.fill('成女参考');
      await savePose.click();
      await picker.selectOption('child');
      assert.equal(await poseList.locator('option').count(),1);
      await picker.selectOption('woman');
      await poseList.selectOption('成女参考');
      await page.locator('#handles').check();
      const original = await readFile(resolve(root,'mannequin.glb'));
      const files = page.locator('#model-files');
      const modelMessage = page.locator('#model-message');
      const waitImport = () => page.waitForFunction(() => !document.querySelector('#model').disabled);
      const assetFile = (name,buffer) => ({name,mimeType:'application/octet-stream',buffer});
      await files.setInputFiles(assetFile('fixture.glb',original));
      await waitImport();
      assert.match(await modelMessage.textContent(),/已绑定人体骨骼/);
      await checkShoulders('imported-glb');
      const neutralImport = await pixels();
      await page.locator('[data-pose=reach]').click();
      assert.notEqual((await pixels()).hash,neutralImport.hash);
      await page.locator('[data-pose=rest]').click();
      assert.equal((await pixels()).hash,neutralImport.hash);
      const {json,binary} = splitGlb(original);
      const head = json.nodes.find(n=>n.name==='head');
      head.name = 'Custom_Head';
      json.nodes.find(n=>n.name==='shoulder01.L').name = 'Custom_ArmBase';
      json.nodes.find(n=>n.name==='clavicle.L').name = 'Custom_Link';
      json.buffers[0].uri = 'fixture.bin';
      const custom = [assetFile('fixture.gltf',Buffer.from(JSON.stringify(json))),assetFile('fixture.bin',binary)];
      await files.setInputFiles(custom);
      await waitImport();
      assert.match(await modelMessage.textContent(),/缺少骨骼：头部/);
      assert.equal(await page.locator('[data-pose=stand]').isEnabled(),false);
      await page.locator('[data-bone=head]').selectOption({label:await page.locator('[data-bone=head] option').filter({hasText:'Custom_Head'}).textContent()});
      await page.locator('#apply-bones').click();
      assert.match(await modelMessage.textContent(),/已绑定人体骨骼/);
      assert.equal(await page.locator('.shoulder[aria-label="左肩"]').count(),0);
      assert.equal(await page.locator('.shoulder[aria-label="右肩"]').count(),1);
      await page.locator('#bone-map summary').click();
      const leftShoulderMap = page.locator('[data-bone=shoulderL]');
      await leftShoulderMap.selectOption({label:await leftShoulderMap.locator('option').filter({hasText:'Custom_ArmBase'}).textContent()});
      await page.locator('#apply-bones').click();
      await checkShoulders('manual-gltf');
      await files.setInputFiles(custom);
      await waitImport();
      assert.match(await modelMessage.textContent(),/已绑定人体骨骼/);
      assert.equal(await page.locator('.shoulder[aria-label="左肩"]').count(),1);

      const {json:vrm,binary:vrmBin} = splitGlb(original);
      const names = {hips:'root',spine:'spine01',head:'head'};
      for (const [side,s] of [['left','L'],['right','R']]) {
        Object.assign(names,Object.fromEntries(Object.entries({
          Shoulder:'shoulder01',UpperArm:'upperarm01',LowerArm:'lowerarm01',Hand:'wrist',
          UpperLeg:'upperleg01',LowerLeg:'lowerleg01',Foot:'foot',
        }).map(([role,bone])=>[side+role,bone+'.'+s])));
      }
      vrm.extensions = {...vrm.extensions,VRMC_vrm:{specVersion:'1.0',humanoid:{humanBones:
        Object.fromEntries(Object.entries(names).map(([role,bone])=>[role,{node:vrm.nodes.findIndex(n=>n.name===bone)}]))}}};
      vrm.extensionsUsed = [...(vrm.extensionsUsed ?? []),'VRMC_vrm'];
      vrm.nodes.forEach((node,index)=>node.name='Node_'+index);
      await files.setInputFiles(assetFile('fixture.vrm',packGlb(vrm,vrmBin)));
      await waitImport();
      assert.match(await modelMessage.textContent(),/已绑定人体骨骼/);
      await checkShoulders('semantic-vrm');
      await files.setInputFiles(assetFile('invalid.fbx',Buffer.from('invalid')));
      await waitImport();
      assert.match(await page.locator('#status').textContent(),/导入失败/);
      assert.equal(await picker.locator('option:checked').textContent(),'fixture.vrm');
      await files.setInputFiles(assetFile('preview.fbx',previewFbx));
      await waitImport();
      assert.equal(await page.locator('#status').isHidden(),true,await page.locator('#status').textContent());
      assert.match(await modelMessage.textContent(),/仅可预览/);
      assert((await pixels()).count>200);
    }
    results.push({name,start,moved,stepped,lit,ballLit,ortho,orbited,wristAngle,poleAngle,torsoAngle,headAngle,footAngle,pelvisAngle,presets:hashes.size,mannequins:seen.size});
    await page.close();
  }
  await writeFile(resolve(output,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  server.close();
}
