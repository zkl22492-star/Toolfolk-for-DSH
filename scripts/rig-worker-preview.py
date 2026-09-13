"""Non-destructive first humanoid rig and authored walk cycle for supplied static worker."""
import bpy, math, os, json
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=r'L:\person\人物001.glb')
mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
bpy.context.view_layer.objects.active=mesh;mesh.select_set(True)
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
mod=mesh.modifiers.new('Preview mesh','DECIMATE');mod.ratio=80000/len(mesh.data.polygons)
bpy.ops.object.modifier_apply(modifier=mod.name)
for img in bpy.data.images:
    if max(img.size)>2048:
        f=2048/max(img.size);img.scale(round(img.size[0]*f),round(img.size[1]*f));img.pack()
arm=bpy.data.armatures.new('WorkerSkeleton');rig=bpy.data.objects.new('WorkerRig',arm);bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
spec=[('hips',(0,0,.50),(0,0,.59),None),('spine',(0,0,.59),(0,0,.73),'hips'),('chest',(0,0,.73),(0,0,.79),'spine'),('neck',(0,0,.79),(0,0,.85),'chest'),('head',(0,0,.85),(0,0,.98),'neck')]
for side,s in [('L',1),('R',-1)]:
    spec += [(f'upper_arm.{side}',(s*.115,0,.765),(s*.185,0,.605),'chest'),(f'forearm.{side}',(s*.185,0,.605),(s*.245,-.006,.465),f'upper_arm.{side}'),(f'hand.{side}',(s*.245,-.006,.465),(s*.274,-.008,.405),f'forearm.{side}'),(f'thigh.{side}',(s*.060,0,.51),(s*.064,-.009,.285),'hips'),(f'shin.{side}',(s*.064,-.009,.285),(s*.070,0,.060),f'thigh.{side}'),(f'foot.{side}',(s*.070,0,.060),(s*.070,-.080,.026),f'shin.{side}')]
for name,head,tail,parent in spec:
    bone=arm.edit_bones.new(name);bone.head=head;bone.tail=tail
    if parent:bone.parent=arm.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT');mesh.select_set(True);rig.select_set(True);bpy.context.view_layer.objects.active=rig
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    if any(len(v.groups)==0 for v in mesh.data.vertices):raise RuntimeError('Unweighted vertices')
    weighting='Blender automatic heat weights'
except Exception as error:
    print('Automatic weights fallback:',error,flush=True)
    mesh.vertex_groups.clear()
    groups={n:mesh.vertex_groups.new(name=n) for n,_,_,_ in spec}
    for v in mesh.data.vertices:
        p=v.co; candidates=[]
        for name,h,t,_ in spec:
            if name.endswith('.L') and p.x<-.015:continue
            if name.endswith('.R') and p.x>.015:continue
            a,b=Vector(h),Vector(t);ab=b-a;u=max(0,min(1,(p-a).dot(ab)/ab.length_squared));d=(p-a-ab*u).length
            candidates.append((d,name))
        nearest=sorted(candidates)[:3];weights=[1/max(d,.005)**5 for d,_ in nearest];total=sum(weights)
        for (_,n),w in zip(nearest,weights):groups[n].add([v.index],w/total,'REPLACE')
    mesh.parent=rig
    if not any(m.type=='ARMATURE' for m in mesh.modifiers):mesh.modifiers.new('Skeleton','ARMATURE').object=rig
    weighting='Segment-distance smooth weights'
for pb in rig.pose.bones:pb.rotation_mode='XYZ'
# Lower arms from the source A-pose, keeping a slight relaxed bend.
for f in range(1,34):
    bpy.context.scene.frame_set(f)
    phase=(f-1)/32*math.tau
    for side,s in [('L',1),('R',-1)]:
        q=phase+(0 if s==1 else math.pi)
        thigh=rig.pose.bones['thigh.'+side];shin=rig.pose.bones['shin.'+side];foot=rig.pose.bones['foot.'+side]
        thigh.rotation_euler=(.30*math.cos(q),0,0)
        shin.rotation_euler=(-.12-.42*max(0,math.sin(q)),0,0)
        foot.rotation_euler=(.12+.16*max(0,math.sin(q)),0,0)
        upper=rig.pose.bones['upper_arm.'+side];upper.rotation_euler=(-.18*math.cos(q),0,-s*.30)
        rig.pose.bones['forearm.'+side].rotation_euler=(-.12,0,0)
    rig.pose.bones['spine'].rotation_euler=(.025,0,.025*math.sin(phase))
    rig.pose.bones['hips'].location=(0,0,0)
    bpy.context.view_layer.update()
    # Keep the lowest sole at the rest ground plane for every sampled pose.
    deps=bpy.context.evaluated_depsgraph_get();ev=mesh.evaluated_get(deps);geo=ev.to_mesh()
    floor=min(v.co.z for v in geo.vertices);ev.to_mesh_clear()
    # hips local Y follows Blender world Z because this bone points upward.
    rig.pose.bones['hips'].location.y=-floor
    for pb in rig.pose.bones:
        pb.keyframe_insert(data_path='rotation_euler',frame=f,group=pb.name)
        if pb.name=='hips':pb.keyframe_insert(data_path='location',frame=f,group=pb.name)
rig.animation_data.action.name='Walk'
bpy.context.scene.render.fps=30;bpy.context.scene.frame_start=1;bpy.context.scene.frame_end=33
bpy.context.scene.frame_set(1)
dest=os.path.abspath('tmp/hunyuan-preview/assets/worker-walk.glb')
bpy.ops.export_scene.gltf(filepath=dest,export_format='GLB',export_animations=True,export_frame_range=True,export_force_sampling=True)
with open(os.path.abspath('tmp/hunyuan-preview/worker-rig.json'),'w') as f:json.dump({'source':r'L:\person\人物001.glb','bones':len(spec),'weighting':weighting,'animation':'Walk','duration':32/30,'triangles':len(mesh.data.polygons),'note':'First authored walk prototype; no finger, facial or stair IK rig yet.'},f,indent=2)
print('WORKER_RIG_READY',dest,flush=True)
