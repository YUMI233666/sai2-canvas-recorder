import { Bone, CapsuleGeometry, CatmullRomCurve3, Group, LatheGeometry, Mesh, MeshStandardMaterial, SphereGeometry, Vector2, Vector3 } from 'three';

export const mannequins = {
  boy: '二次元 · 少年',
  man: '二次元 · 成男',
  child: '二次元 · 萝莉',
  girl: '二次元 · 少女',
  woman: '二次元 · 成女',
};

// Stature, head length and width, shoulder and hip half-width, waist, leg ratio, limb mass.
const proportions = {
  boy:   [1.55,.245,.166,.169,.124,.106,.522,.88],
  man:   [1.82,.246,.169,.224,.148,.128,.535,1.18],
  child: [1.22,.268,.196,.127,.105,.091,.475,.75],
  girl:  [1.55,.251,.172,.146,.136,.101,.538,.84],
  woman: [1.70,.236,.162,.166,.162,.104,.550,.97],
};
const up = new Vector3(0,1,0);

export function createMannequin(id) {
  const [height,head,face,shoulder,hip,waist,leg,mass] = proportions[id];
  const model = new Group();
  const clay = new MeshStandardMaterial({color:0xb0a79e,roughness:.76});
  const ball = new SphereGeometry(1,28,20);
  const ellipsoid = (parent,x,y,z,sx,sy,sz) => {
    const mesh = new Mesh(ball,clay);
    mesh.position.set(x,y,z);
    mesh.scale.set(sx,sy,sz);
    parent.add(mesh);
    return mesh;
  };
  const bone = (parent,name,x,y,z=0) => {
    const node = new Bone();
    node.name = name;
    node.position.set(x,y,z);
    parent.add(node);
    return node;
  };
  const profile = (parent,points,depth) => {
    const curve = new CatmullRomCurve3(points.map(([h,r])=>new Vector3(r,h,0)));
    const outline = curve.getPoints(points.length*5).map(p=>new Vector2(Math.max(0,p.x),p.y));
    const mesh = new Mesh(new LatheGeometry(outline,40),clay);
    mesh.scale.z = depth;
    parent.add(mesh);
    return mesh;
  };
  const segment = (parent,end,radius,taper,depth=.90) => {
    const length = end.length();
    const mesh = profile(parent,[
      [-radius*.70,0],[-radius*.45,radius*.67],[0,radius*.86],[length*.22,radius],
      [length*.52,radius*.89],[length*.81,taper*1.10],[length,taper*.88],[length+taper*.51,0],
    ],depth);
    mesh.quaternion.setFromUnitVectors(up,end.clone().normalize());
  };
  const pelvisY = height*leg, neckY = height-head, torso = neckY-pelvisY;
  const root = bone(model,'root',0,pelvisY);
  profile(root,[[-.088,0],[-.065,hip*.58],[-.025,hip*.96],[.023,hip],[.075,waist*.98],[.090,waist*.72],[.095,0]],.63);
  const spine = bone(root,'spine01',0,.061);
  const top = torso-.061;
  profile(spine,[[-.041,0],[-.025,waist*.99],[.045,waist],[top*.45,shoulder*.66],
    [top*.72,shoulder*.83],[top*.85,shoulder*.78],[top*.95,shoulder*.60],[top+.020,.035],[top+.024,0]],.59);
  const neck = .045*mass;
  ellipsoid(spine,0,top-.013,0,neck,.065,neck*.91);
  const skull = bone(spine,'head',0,top-.018);
  const headShape = profile(skull,[[.012,0],[.023,face*.22],[.040,face*.36],[head*.32,face*.44],
    [head*.50,face*.49],[head*.68,face*.50],[head*.84,face*.45],[head*.96,face*.33],[head*1.015,face*.17],[head*1.030,0]],.90);
  const positions = headShape.geometry.attributes.position;
  const soft = (d,w) => Math.exp(-((d/w)**2));
  for (let i=0;i<positions.count;i++) {
    const x = positions.getX(i)/face, y = positions.getY(i)/head, z = positions.getZ(i)/face;
    if (z<=0) continue;
    const sockets = soft(Math.abs(x)-.235,.104)*soft(y-.48,.069);
    const nose = soft(x,.079)*soft(y-.353,.077);
    const brow = soft(Math.abs(x)-.20,.14)*soft(y-.56,.052);
    const lip = soft(x,.155)*soft(y-.24,.040);
    positions.setZ(i,face*(z+Math.min(1,z*3)*(.090*nose-.059*sockets+.025*brow+.024*lip)));
  }
  headShape.geometry.computeVertexNormals();
  headShape.position.z = .008;
  for (const sign of [1,-1]) {
    const s = sign===1?'L':'R';
    ellipsoid(skull,sign*face*.464,head*.46,0,face*.077,head*.092,face*.10);
    const upper = bone(spine,'upperarm01'+s,sign*shoulder*.86,top*.79);
    const arm = height*.177;
    const elbow = bone(upper,'lowerarm01'+s,sign*height*.039,-arm,-.013);
    const wrist = bone(elbow,'wrist'+s,sign*height*.017,-height*.152,.016);
    segment(upper,elbow.position,.046*mass,.030*mass);
    segment(elbow,wrist.position,.033*mass,.021*mass);
    ellipsoid(elbow,0,0,0,.026*mass,.024*mass,.026*mass);
    const hand = height*.074;
    ellipsoid(wrist,0,-hand*.28,0,.029*mass,hand*.42,.015*mass);
    for (let i=0;i<4;i++) {
      const finger = new Mesh(new CapsuleGeometry(.0058*mass,hand*(i===3?.175:.245),5,10),clay);
      finger.position.set((i-1.5)*.012*mass,-hand*(i===3?.64:.70),.004);
      wrist.add(finger);
    }
    const thumb = ellipsoid(wrist,-sign*.027*mass,-hand*.31,.010,.010*mass,hand*.25,.011*mass);
    thumb.rotation.z = -sign*.49;
    const thigh = bone(root,'upperleg01'+s,sign*hip*.57,-.040);
    const knee = bone(thigh,'lowerleg01'+s,sign*.018,-(pelvisY-.105)*.51,.018);
    const ankle = bone(knee,'foot'+s,sign*.004,-(pelvisY-.105)*.49,-.016);
    segment(thigh,knee.position,hip*.51,.042*mass,.92);
    segment(knee,ankle.position,.045*mass,.026*mass);
    ellipsoid(knee,0,0,0,.036*mass,.036*mass,.033*mass);
    ellipsoid(ankle,0,-.020,.021,.031*mass,.035,height*.042);
    ellipsoid(ankle,0,-.031,height*.045,.034*mass,.021,height*.037);
  }
  return model;
}
