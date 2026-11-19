import { Euler, Matrix4, Quaternion, Vector3, MathUtils } from 'three';

const v = (x=0,y=0,z=0) => new Vector3(x,y,z);
const world = node => node.getWorldPosition(v());
const q = () => new Quaternion();
const DEG = MathUtils.DEG2RAD;

export const LIMBS = [
  ['左手','upperarm01L','lowerarm01L','wristL', [.4,-1,-.4]],
  ['右手','upperarm01R','lowerarm01R','wristR', [-.4,-1,-.4]],
  ['左脚','upperleg01L','lowerleg01L','footL', [0,0,1]],
  ['右脚','upperleg01R','lowerleg01R','footR', [0,0,1]],
];

export const jointRanges = {
  hand: [['手腕弯伸', -75, 75], ['手腕侧偏', -35, 35], ['手掌翻转', -180, 180]],
  foot: [['脚尖抬压', -180, 180], ['脚掌侧倾', -30, 30], ['脚尖内外转', -45, 45]],
  torso: [['躯干前后倾', -48, 48], ['躯干转向', -55, 55], ['躯干左右侧倾', -45, 45]],
  head: [['头部抬低', -60, 60], ['头部转向', -80, 80], ['头部左右侧倾', -45, 45]],
  pelvis: [['胯部前后倾', -50, 50], ['胯部转向', -60, 60], ['胯部左右侧倾', -45, 45]],
};

export const shoulderRange = [-20,32];
export const shoulderSlots = [['shoulderL','左肩','leftShoulder'],['shoulderR','右肩','rightShoulder']];

const angleOrder = {hand:'ZXY', foot:'YZX', torso:'YXZ', head:'YXZ', pelvis:'YXZ'};

function adjustment(joint) {
  const [a,b,c] = joint.angles.map(angle => angle*DEG);
  const side = joint.right ? -1 : 1;
  const xyz = joint.kind === 'foot' ? [-a,b*side,-c*side] :
    joint.kind === 'hand' ? [b,c*side,a*side] : [a,b,c];
  return q().setFromEuler(new Euler(...xyz,angleOrder[joint.kind]));
}

export function jointWorldRotation(joint) {
  return joint.neutralWorld.clone().multiply(adjustment(joint));
}

export function setJointWorldRotation(joint, rotation) {
  const local = joint.neutralWorld.clone().invert().multiply(rotation);
  const {x,y,z} = new Euler().setFromQuaternion(local,angleOrder[joint.kind]);
  const side = joint.right ? -1 : 1;
  const values = joint.kind === 'foot' ? [-x,y*side,-z*side] :
    joint.kind === 'hand' ? [z*side,x,y*side] : [x,y,z];
  for (const [i,[,min,max]] of jointRanges[joint.kind].entries()) {
    joint.angles[i] = MathUtils.clamp(values[i]/DEG,min,max);
  }
}

function bodyJoint(bone, kind, frame) {
  // Anatomical axes align with the standing figure, not the asset's bone orientation.
  return {kind,bone,angles:[0,0,0],neutralWorld:q(),
    frameInParent:bone.parent.getWorldQuaternion(q()).invert().multiply(frame),
    boneInFrame:frame.clone().invert().multiply(bone.getWorldQuaternion(q()))};
}

function updateBodyJoint(joint) {
  const {bone,neutralWorld,frameInParent,boneInFrame} = joint;
  neutralWorld.copy(bone.parent.getWorldQuaternion(q())).multiply(frameInParent);
  bone.quaternion.copy(frameInParent).multiply(adjustment(joint)).multiply(boneInFrame);
  bone.updateWorldMatrix(false,true);
}

export function shoulderBone(upper, torso, semantic) {
  let named;
  if (!upper || !torso) return null;
  for (let bone = upper.parent; bone && bone !== torso; bone = bone.parent) {
    if (!bone.isBone) continue;
    if (bone === semantic) return bone;
    if (!named && /shoulder|clavicle|collar/i.test(bone.name)) named = bone;
  }
  return named ?? null;
}

function shoulderJoint(upper, bone, frame) {
  if (!bone) return null;
  const lateral = v(1,0,0).applyQuaternion(frame);
  const distance = world(upper).sub(world(bone)).dot(lateral);
  if (Math.abs(distance)<.001) return null;
  const axis = v(0,0,Math.sign(distance)).applyQuaternion(frame)
    .applyQuaternion(bone.parent.getWorldQuaternion(q()).invert());
  return {bone,axis,base:bone.quaternion.clone(),angle:0};
}

const presets = {
  stand: [0,0,0,[.232,.805,.047],[-.232,.805,.047],[.13,.067,.03],[-.13,.067,.03]],
  walk:  [-.044,-10,7,[.24,.84,-.09],[-.27,.92,.27],[.13,.067,.24],[-.13,.11,-.27]],
  run:   [-.088,-19,17,[.24,.97,-.25],[-.246,1.15,.32],[.13,.16,.42],[-.13,.31,-.30]],
  sit:   [-.402,4,8,[.25,.59,.26],[-.24,.59,.25],[.18,.067,.36],[-.18,.067,.36]],
  crouch:[-.374,-5,27,[.20,.75,.40],[-.24,.68,.32],[.24,.072,.12],[-.24,.072,.13]],
  reach: [-.015,-12,-5,[.24,1.59,.055],[-.22,.83,.1],[.13,.067,.03],[-.13,.067,.05]],
};

// Wrist bend, deviation, and palm roll for the retargeted arms.
const wristPresets = {
  stand: [[4,0,0],[4,0,0]],
  walk: [[4,0,6],[12,0,14]],
  run: [[10,0,18],[18,0,30]],
  sit: [[-8,0,12],[-8,0,12]],
  crouch: [[-12,0,20],[-8,0,15]],
  reach: [[-16,0,24],[6,0,4]],
};

function swing(bone, next, where) {
  const origin = world(bone);
  const from = world(next).sub(origin).normalize(), to = where.clone().sub(origin).normalize();
  const turn = q().setFromUnitVectors(from,to);
  const parent = bone.parent.getWorldQuaternion(q());
  bone.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
  bone.updateWorldMatrix(false,true);
}

const within = (value,min,max) => typeof value === 'number' && value >= min && value <= max;
const validAngles = (angles,kind) => Array.isArray(angles) && angles.length===3 &&
  jointRanges[kind].every(([,min,max],i)=>within(angles[i],min,max));

export class PoseRig {
  constructor(model, {mapping,legacy=true,height=1.7,extras={}} = {}) {
    this.model = model;
    this.legacy = legacy;
    this.scale = height/1.7;
    const node = name => {
      const bone = mapping ? mapping[name] : model.getObjectByName(name);
      if (!bone?.isBone) throw Error('缺少骨骼 ' + name);
      return bone;
    };
    this.pelvis = node('root');
    this.hips = this.pelvis.position.clone();
    const head = node('head');
    if (legacy) head.scale.multiplyScalar(1.14);
    model.updateMatrixWorld(true);
    this.frame = q();
    if (!legacy) {
      const side = world(node(LIMBS[0][1])).sub(world(node(LIMBS[1][1])));
      side.y = 0;
      if (side.lengthSq() > 1e-6) this.frame.setFromAxisAngle(v(0,1,0),Math.atan2(-side.z,side.x));
    }
    this.body = {
      pelvis: bodyJoint(this.pelvis,'pelvis',this.frame),
      torso: bodyJoint(node('spine01'),'torso',this.frame),
      head: bodyJoint(head,'head',this.frame),
    };
    this.chains = LIMBS.map(([label,a,b,c,pole],i) => {
      const [upper,lower,end] = [node(a),node(b),node(c)];
      const origin = world(upper), middle = world(lower), tip = world(end);
      const axis = tip.clone().sub(origin).normalize();
      const bend = middle.clone().sub(origin);
      bend.addScaledVector(axis,-bend.dot(axis));
      const l1 = origin.distanceTo(middle), l2 = middle.distanceTo(tip);
      if (Math.min(l1,l2)<.001) throw Error(label+'的骨骼长度无效。');
      const armStand = !legacy && i<2
        ? origin.clone().addScaledVector(v(i===0 ? .12 : -.12,-.97,.08).applyQuaternion(this.frame),l1+l2)
        : null;
      const orientation = q();
      if (!legacy) {
        let x, y, z;
        const extra = extras[c];
        if (i>1) {
          y = extra ? world(extra).sub(tip) : v(0,0,1).applyQuaternion(this.frame);
          y.y = 0;
          if (y.lengthSq()<.000001) y.set(0,0,1).applyQuaternion(this.frame);
          y.normalize();
          z = v(0,-1,0);
          x = y.clone().cross(z).normalize();
        } else {
          y = (extra ? world(extra).sub(tip) : tip.clone().sub(middle)).normalize();
          if (y.lengthSq()<.000001) y.copy(tip).sub(middle).normalize();
          z = v(0,0,1).applyQuaternion(this.frame);
          if (Math.abs(y.dot(z))>.9) z.set(0,1,0);
          x = y.clone().cross(z).normalize();
          z = x.clone().cross(y);
        }
        orientation.copy(end.getWorldQuaternion(q())).invert().multiply(q().setFromRotationMatrix(new Matrix4().makeBasis(x,y,z)));
      }
      const shoulder = i<2 ? shoulderJoint(upper,mapping
        ? mapping[shoulderSlots[i][0]] : shoulderBone(upper,this.body.torso.bone),this.frame) : null;
      return {label,upper,lower,end,shoulder,pole:!legacy && bend.lengthSq()>.000009
        ? bend.normalize() : v(...pole).applyQuaternion(this.frame),
        angle:0,target:tip.clone(), restTarget:tip, leg:i>1, right:i%2===1, orientation,
        kind:i>1 ? 'foot' : 'hand', angles:[0,0,0], neutralWorld:q(),
        l1,l2,armStand,
        base:[upper,lower,end].map(bone => bone.quaternion.clone())};
    });
    if (!legacy) {
      this.rest();
      return;
    }
    const feet = this.chains.filter(c => c.leg);
    const standingFeet = feet.map(c => c.end.getWorldQuaternion(q()));
    this.preset('stand');
    // Keep the old neutral stance, but thereafter carry that offset with each solved shin.
    feet.forEach((c,i) => {
      c.base[2].copy(c.end.parent.getWorldQuaternion(q()).invert().multiply(standingFeet[i]));
    });
    this.update();
  }

  preset(name) {
    const [dip,twist,lean,...goals] = presets[name];
    this.drop = dip*this.scale;
    for (const joint of Object.values(this.body)) joint.angles.fill(0);
    this.body.torso.angles = [lean,twist,0];
    for (const [i, limb] of this.chains.entries()) {
      limb.angle = 0;
      if (limb.shoulder) limb.shoulder.angle = 0;
      limb.angles.fill(0);
      const [gx,gy,gz] = goals[i];
      limb.target.set(gx,gy,gz);
      if (!this.legacy) {
        const [x,y,z] = presets.stand[i+3];
        const movement = v(gx-x,gy-y,gz-z).applyQuaternion(this.frame);
        if (limb.armStand) {
          // A T-pose wrist is not the origin for movements authored from a standing pose.
          limb.target.copy(limb.armStand).addScaledVector(movement,this.scale);
          limb.angles = [...wristPresets[name][i]];
        } else {
          limb.target.copy(limb.restTarget).addScaledVector(movement,this.scale);
        }
      }
    }
    this.update();
  }

  rest() {
    this.drop = 0;
    for (const joint of Object.values(this.body)) joint.angles.fill(0);
    for (const limb of this.chains) {
      limb.angle = 0;
      if (limb.shoulder) limb.shoulder.angle = 0;
      limb.angles.fill(0);
      limb.target.copy(limb.restTarget);
    }
    this.update();
  }

  capturePose() {
    return {
      drop:this.drop,
      body:Object.fromEntries(Object.entries(this.body).map(([kind,joint])=>[kind,[...joint.angles]])),
      limbs:this.chains.map(c=>({target:c.target.toArray(),pole:c.angle,angles:[...c.angles]})),
      shoulders:this.chains.slice(0,2).map(c=>c.shoulder?.angle ?? 0),
    };
  }

  restorePose(pose) {
    const body = Object.entries(this.body);
    const shoulders = pose?.shoulders === undefined ? [0,0] : pose.shoulders;
    if (!within(pose?.drop,-1,1) || !body.every(([kind])=>validAngles(pose.body?.[kind],kind)) ||
        !Array.isArray(shoulders) || shoulders.length!==2 ||
        !shoulders.every(value=>within(value,...shoulderRange)) ||
        !Array.isArray(pose.limbs) || pose.limbs.length!==this.chains.length ||
        !this.chains.every((c,i) => {
          const item = pose.limbs[i];
          return within(item?.pole,-150,150) && validAngles(item.angles,c.kind) &&
            Array.isArray(item.target) && item.target.length===3 && item.target.every(Number.isFinite);
        })) return false;
    this.drop = pose.drop;
    for (const [kind,joint] of body) joint.angles = [...pose.body[kind]];
    this.chains.forEach((c,i) => {
      const item = pose.limbs[i];
      c.target.fromArray(item.target);
      c.angle = item.pole;
      c.angles = [...item.angles];
      if (c.shoulder) c.shoulder.angle = shoulders[i];
    });
    this.update();
    return true;
  }

  update() {
    this.pelvis.position.copy(this.hips);
    if (this.legacy) this.pelvis.position.y += this.drop;
    else if (this.drop) {
      const parent = this.pelvis.parent;
      this.pelvis.position.copy(parent.worldToLocal(parent.localToWorld(this.hips.clone()).add(v(0,this.drop))));
    }
    for (const c of this.chains) {
      [c.upper,c.lower,c.end].forEach((bone,i) => bone.quaternion.copy(c.base[i]));
    }
    this.model.updateMatrixWorld(true);
    for (const joint of Object.values(this.body)) updateBodyJoint(joint);
    for (const {shoulder} of this.chains) {
      if (!shoulder) continue;
      const {bone,axis,base,angle} = shoulder;
      bone.quaternion.setFromAxisAngle(axis,angle*DEG).multiply(base);
      bone.updateWorldMatrix(false,true);
    }
    for (const c of this.chains) this.solve(c);
  }

  solve(c) {
    if (!this.legacy && c.angle === 0 && world(c.end).distanceToSquared(c.target)<1e-12) {
      this.rotateEnd(c);
      return c.l1+c.l2;
    }
    // Two-bone solve: the pole fixes the elbow/knee plane; reach limits avoid folded singularities.
    const origin = world(c.upper), axis = c.target.clone().sub(origin);
    const distance = axis.length();
    if (distance < 1e-5) axis.set(0,-1,0);
    else axis.multiplyScalar(1/distance);
    const fold = c.leg ? 148 : 150;
    const minReach = Math.sqrt(c.l1*c.l1 + c.l2*c.l2 + 2*c.l1*c.l2*Math.cos(fold*DEG));
    const reach = MathUtils.clamp(distance,minReach,c.l1+c.l2-.0008);
    const pole = c.pole.clone().addScaledVector(axis,-c.pole.dot(axis));
    if (pole.lengthSq() < 1e-5) pole.copy(v(0,1,0).cross(axis));
    if (pole.lengthSq() < 1e-5) pole.set(1,0,0);
    pole.normalize().applyAxisAngle(axis,c.angle*DEG);
    const a = (c.l1*c.l1 - c.l2*c.l2 + reach*reach)/(2*reach);
    const b = Math.sqrt(Math.max(0,c.l1*c.l1-a*a));
    swing(c.upper,c.lower,origin.clone().addScaledVector(axis,a).addScaledVector(pole,b));
    swing(c.lower,c.end,origin.clone().addScaledVector(axis,reach));
    this.rotateEnd(c);
    return reach;
  }

  rotateEnd(c) {
    c.end.getWorldQuaternion(c.neutralWorld).multiply(c.orientation);
    c.end.quaternion.multiply(c.orientation).multiply(adjustment(c)).multiply(c.orientation.clone().invert());
    c.end.updateWorldMatrix(false,true);
  }
}
