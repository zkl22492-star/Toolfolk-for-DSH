"""Deterministic procedural texture sources for the v2 GLB kit; no external images."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math, random

OUT=Path('assets/3d/v2/textures'); OUT.mkdir(parents=True,exist_ok=True)
rng=random.Random(20260911)
EMBED=OUT/'gltf'; EMBED.mkdir(parents=True,exist_ok=True)
def save(im,name):
    im.save(OUT/(name+'.png'),optimize=True)
    im.transpose(Image.Transpose.FLIP_TOP_BOTTOM).save(EMBED/(name+'.png'),optimize=True)
def font(size,bold=False):
    p=Path('C:/Windows/Fonts/'+('arialbd.ttf' if bold else 'arial.ttf'))
    return ImageFont.truetype(str(p),size)

# Warm, fine oak grain. Long grain runs across U and is embedded in each GLB.
im=Image.new('RGB',(1024,512),(218,184,140));d=ImageDraw.Draw(im)
for y in range(512):
    wave=math.sin(y*.13)*2+math.sin(y*.039)*3+rng.uniform(-1.5,1.5)
    col=tuple(int(c+wave) for c in (218,184,140));d.line((0,y,1024,y),fill=col)
for i in range(135):
    y=rng.randrange(512);amp=rng.uniform(.5,4);phase=rng.random()*8
    pts=[(x,y+math.sin(x*.008+phase)*amp+math.sin(x*.023)*.8) for x in range(0,1025,8)]
    d.line(pts,fill=(201+rng.randrange(12),164+rng.randrange(10),121+rng.randrange(10)),width=1)
save(im.filter(ImageFilter.GaussianBlur(.45)),'oak')

im=Image.new('RGB',(256,256),(221,218,208));d=ImageDraw.Draw(im)
for y in range(256):
    for x in range(256):
        v=rng.randint(-9,9)+(3 if (x+y)%4<2 else -3)
        d.point((x,y),fill=(221+v,218+v,208+v))
for y in range(0,256,3):d.line((0,y,256,y),fill=(213,210,200))
save(im,'fabric')

# An illustrated view outside the window: layered blue distance and soft foliage.
im=Image.new('RGB',(1024,512));d=ImageDraw.Draw(im)
for y in range(512):
    t=y/512;d.line((0,y,1024,y),fill=tuple(int(a*(1-t)+b*t) for a,b in zip((170,200,226),(239,235,207))))
for x,y,w,h in [(70,270,65,210),(175,305,70,220),(260,235,42,280),(760,265,57,280),(843,310,60,220)]:
    d.rectangle((x,y,x+w,y+h),fill=(167,184,192))
    for yy in range(y+10,y+h,18):d.line((x+7,yy,x+w-7,yy),fill=(202,210,207),width=4)
for i in range(190):
    x=rng.randrange(-70,1120);y=rng.randrange(280,590);r=rng.randrange(18,55)
    d.ellipse((x-r,y-r,x+r,y+r),fill=rng.choice([(142,168,109),(168,186,125),(190,201,146),(203,206,152),(132,157,106)]))
save(im.filter(ImageFilter.GaussianBlur(4)),'window')

def screen(kind):
    im=Image.new('RGB',(768,480),(238,239,232));d=ImageDraw.Draw(im)
    if kind=='code':
        d.rectangle((0,0,768,480),fill='#243640');d.rectangle((0,0,768,33),fill='#344851');d.rectangle((0,33,140,480),fill='#2c3e47')
        for i,t in enumerate(['EXPLORER','src','  studio','  employees','  states','  scene','assets','package.json']):d.text((13,49+i*30),t,font=font(13),fill='#b5c7bf')
        lines=[('import { Studio } from "workspace"','#a3bccb'),('','#ffffff'),('const team = createTeam({','#d6c4a0'),('  mood: "a brighter workday",','#b4c99c'),('  light: "soft-morning",','#b4c99c'),('  workers: activePlugins','#d8d6cb'),('});','#d8d6cb'),('','#ffffff'),('await team.observe(session);','#a1c3cc'),('team.on("activity", updateDesk);','#d4b18e'),('','#ffffff'),('// Small things, thoughtfully made.','#889c95'),('render(<Studio team={team} />);','#b6c1dc')]
        for i,(s,c) in enumerate(lines):d.text((158,57+i*26),s,font=font(17),fill=c)
        d.rectangle((140,420,768,480),fill='#203039');d.text((160,439),'Ready   /   Watching workspace',font=font(15),fill='#a6c69e')
    elif kind=='research':
        d.rectangle((0,0,768,45),fill='#d2dcd6');d.rounded_rectangle((75,9,645,36),10,fill='#f4f5ed');d.text((94,14),'Research library',font=font(14),fill='#78887e')
        d.rectangle((0,45,175,480),fill='#e5e9e1');d.text((22,70),'COLLECTIONS',font=font(14,True),fill='#687e72')
        for i,t in enumerate(['Overview','Sources','Notes','Archive']):d.text((24,110+i*37),t,font=font(17),fill='#7b8f82')
        d.text((205,74),'Ideas worth exploring',font=font(28,True),fill='#3e5d52')
        for i in range(3):
            y=133+i*103;d.rounded_rectangle((200,y,735,y+84),9,fill='#fafaf3');d.rectangle((215,y+15,298,y+68),fill=['#a3b8ac','#b6c4cd','#d1ba9c'][i]);d.text((320,y+14),['A new perspective','Notes from the field','Patterns and connections'][i],font=font(19),fill='#536e63')
            for j in range(2):d.line((320,y+46+j*12,695-j*55,y+46+j*12),fill='#c6cfc5',width=4)
    elif kind=='document':
        d.rectangle((0,0,768,40),fill='#d0d8dc');d.text((25,12),'Studio report  /  Draft',font=font(15),fill='#65757d');d.rectangle((131,63,639,480),fill='#fffdf7');d.text((171,97),'A brighter workday',font=font(28,True),fill='#4f6159');d.text((171,140),'Research notes and thoughtful next steps',font=font(16),fill='#8b938a')
        for i in range(9):d.line((173,183+i*17,595-(i%3)*38,183+i*17),fill='#c7cdc5',width=4)
        for i,h in enumerate([48,80,65,110,91]):d.rectangle((192+i*72,430-h,225+i*72,430),fill=['#9aaf99','#9db4c2','#ccb094'][i%3])
    else:
        d.rectangle((0,0,768,480),fill='#e7ded0');d.rectangle((0,0,768,35),fill='#d2c8b9');d.rectangle((38,58,565,452),fill='#f9f5ec');d.text((67,85),'FORM & COLOUR',font=font(22),fill='#777e68')
        d.ellipse((117,165,353,400),fill='#b6bea0');d.rounded_rectangle((249,141,458,380),55,fill='#c99277');d.ellipse((185,267,358,435),fill='#e4cda5')
        for i,c in enumerate(['#81927b','#cc967c','#e5cfa7','#93adbc','#f3eedf']):d.rounded_rectangle((603,73+i*72,706,123+i*72),9,fill=c)
    return im
for k in ['code','research','document','design']:save(screen(k),'screen-'+k)

im=Image.new('RGB',(768,480),'#293e4a');d=ImageDraw.Draw(im)
for r in [60,98,142,175]:d.ellipse((384-r,240-r,384+r,240+r),outline='#9eafb5',width=2)
for a in range(0,360,24):
    x=384+math.cos(a*math.pi/180)*163;y=240+math.sin(a*math.pi/180)*163
    d.line((384,240,x,y),fill='#698e9b',width=2);d.ellipse((x-6,y-6,x+6,y+6),fill='#d5c9a4')
d.text((25,20),'CONNECTION MAP',font=font(18),fill='#b7c9cc');save(im,'screen-map')

im=Image.new('RGB',(384,512),'#f0eadc');d=ImageDraw.Draw(im)
for i,t in enumerate(['Good','People','Make','Good','Things']):d.text((57,44+i*65),t,font=font(44),fill='#687261')
d.line((173,397,180,473),fill='#8b9b78',width=5)
for x,y,r in [(150,419,-20),(192,432,20),(161,448,-20)]:d.ellipse((x-20,y-10,x+20,y+10),fill='#9bab8c')
save(im,'poster-type')
im=Image.new('RGB',(384,512),'#eee9df');d=ImageDraw.Draw(im);d.ellipse((73,80,290,296),fill='#b5c1c5');d.polygon([(72,396),(198,179),(318,396)],fill='#d4c8b2');d.ellipse((224,116,301,193),fill='#dec494');d.text((68,450),'SLOW / CREATE',font=font(20),fill='#8d9285');save(im,'poster-art')
im=Image.new('RGB',(1024,256),'#7e907b');d=ImageDraw.Draw(im);d.text((512,90),'A brighter workday',font=font(49),fill='#e8e9d9',anchor='mm');d.text((512,160),'MAKE ROOM FOR GOOD IDEAS',font=font(20),fill='#cbd2be',anchor='mm');save(im,'console-label')
print('Texture sources:',len(list(OUT.glob('*.png'))))
