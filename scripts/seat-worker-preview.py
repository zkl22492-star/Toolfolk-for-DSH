"""Create seated working/idle variants from the user's original, not the rejected walk."""
import bpy, math, os, json
from mathutils import Vector, Matrix
# Reuse mesh preparation and skeleton only; no walking poses are executed.
source=open('scripts/rig-worker-preview.py',encoding='utf-8').read()
exec(source.split('for pb in rig.pose.bones:')[0])

# Anatomical regions prevent nearby arms influencing the sweater and pelvis.
mesh.vertex_groups.clear()
groups={n:mesh.vertex_groups.new(name=n) for n,_,_,_ in spec}
for v in mesh.data.vertices:
    p=v.co;z=p.z;x=abs(p.x);side='L' if p.x>=0 else 'R'
    if z>.81:names=['head','neck']
    elif x>.12+max(0,.74-z)*.32 and z>.38:names=['upper_arm.'+side,'forearm.'+side,'hand.'+side]
    elif z<.49:names=['thigh.'+side,'shin.'+side,'foot.'+side,'hips'] if z>.42 else ['thigh.'+side,'shin.'+side,'foot.'+side]
    else:names=['hips','spine','chest','neck']
    ds=[]
    for n,h,t,_ in spec:
        if n not in names:continue
        a,b=Vector(h),Vector(t);ab=b-a;u=max(0,min(1,(p-a).dot(ab)/ab.length_squared));ds.append(((p-a-ab*u).length,n))
    ds=sorted(ds)[:2];ws=[1/max(d,.004)**6 for d,_ in ds];total=sum(ws)
    for (_,n),w in zip(ds,ws):groups[n].add([v.index],w/total,'REPLACE')

def aim(name,head,tail):
    pb=rig.pose.bones[name];head=Vector(head);tail=Vector(tail)
    q=(tail-head).to_track_quat('Y','Z')
    # Preserve bone roll from rest through a minimal swing rotation.
    rest=pb.bone.matrix_local.to_quaternion();direction=pb.bone.tail_local-pb.bone.head_local
    q=direction.rotation_difference(tail-head) @ rest
    pb.matrix=Matrix.LocRotScale(head,q,Vector((1,1,1)))
    bpy.context.view_layer.update()

def pose(t,working):
    breath=.0014*math.sin(t*math.tau/4)
    lean=.008 if working else 0
    aim('hips',(0,0,.365),(0,0,.455))
    aim('spine',(0,0,.455),(0,-lean,.595+breath))
    aim('chest',(0,-lean,.595+breath),(0,-lean,.655+breath))
    aim('neck',(0,-lean,.655+breath),(0,-lean-.004,.715+breath))
    headyaw=(.004 if working else .020)*math.sin(t*math.tau/4)
    aim('head',(0,-lean-.004,.715+breath),(headyaw,-lean-(.015 if working else .004),.845+breath))
    for side,s in [('L',1),('R',-1)]:
        hip=(s*.06,0,.375);knee=(s*.075,-.195,.262);ankle=(s*.077,-.195,.037)
        aim('thigh.'+side,hip,knee);aim('shin.'+side,knee,ankle);aim('foot.'+side,ankle,(s*.077,-.275,.003))
        shoulder=(s*.115,-lean,.630+breath)
        elbow=(s*.150,-.035,.548+breath)
        tap=(.0035*math.sin(t*math.tau*2.5+(0 if s>0 else math.pi))) if working else 0
        wrist=(s*.108,-.230,.563+tap)
        aim('upper_arm.'+side,shoulder,elbow);aim('forearm.'+side,elbow,wrist)
        aim('hand.'+side,wrist,(s*.105,-.294,.561+tap))
        pb=rig.pose.bones['hand.'+side];pb.matrix=pb.matrix @ Matrix.Rotation(math.pi,4,'Y')
        bpy.context.view_layer.update()

rig.animation_data_clear()
for name,working in [('Idle',False),('Working',True)]:
    action=bpy.data.actions.new(name);rig.animation_data_create();rig.animation_data.action=action
    for f in range(1,122,2):
        bpy.context.scene.frame_set(f);pose((f-1)/30,working)
        for pb in rig.pose.bones:
            pb.rotation_mode='QUATERNION'
            pb.keyframe_insert(data_path='location',frame=f,group=pb.name)
            pb.keyframe_insert(data_path='rotation_quaternion',frame=f,group=pb.name)
            pb.keyframe_insert(data_path='scale',frame=f,group=pb.name)
    track=rig.animation_data.nla_tracks.new();track.name=name;strip=track.strips.new(name,1,action)
    rig.animation_data.action=None
bpy.context.scene.frame_start=1;bpy.context.scene.frame_end=121;bpy.context.scene.render.fps=30
bpy.context.scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=os.path.abspath('tmp/hunyuan-preview/assets/worker-seated.glb'),export_format='GLB',export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True)
print('SEATED_WORKER_READY',flush=True)
