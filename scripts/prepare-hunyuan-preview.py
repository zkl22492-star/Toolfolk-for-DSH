"""Create local preview derivatives; never modify source GLBs."""
import bpy, os, json, time
SOURCE = r'L:\tencentglb'
DEST = os.path.abspath('tmp/hunyuan-preview/assets')
os.makedirs(DEST, exist_ok=True)
assets = [('地台','platform',30000),('工位桌子','desk',100000),('椅子','chair',80000),('环形桌','console',140000),('沙发','sofa',100000),('书柜','bookcase',100000),('台灯','lamp',30000),('盆栽','plant',60000)]
report = []
for source, name, target in assets:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SOURCE, source+'.glb'))
    before = sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
    for obj in list(bpy.context.scene.objects):
        if obj.type != 'MESH': continue
        bpy.context.view_layer.objects.active=obj
        obj.select_set(True)
        if before > target:
            mod=obj.modifiers.new('Preview reduction','DECIMATE')
            mod.ratio=target/before
            bpy.ops.object.modifier_apply(modifier=mod.name)
        obj.select_set(False)
    for img in bpy.data.images:
        w,h=img.size
        if max(w,h)>2048:
            factor=2048/max(w,h)
            img.scale(round(w*factor),round(h*factor))
            img.pack()
    output=os.path.join(DEST,name+'.glb')
    bpy.ops.export_scene.gltf(filepath=output,export_format='GLB',export_image_format='AUTO',export_extras=True)
    after=sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
    report.append(dict(name=name,source=source+'.glb',before=before,after=after,bytes=os.path.getsize(output)))
    print('ASSET_READY '+json.dumps(report[-1]),flush=True)
    with open(os.path.join(DEST,'manifest.json'),'w',encoding='utf-8') as f: json.dump(report,f,ensure_ascii=False,indent=2)
