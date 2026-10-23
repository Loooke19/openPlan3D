import fitz, math
NAMES={1:["挂号收费","药房","候诊区","检验科","放射科","急诊","输液室","采血处","门诊大厅","卫生间","超声科"],
       2:["内科诊室","外科诊室","儿科","眼科","康复室","护士站","口腔科","皮肤科","心电图室","卫生间","耳鼻喉科"]}
doc=fitz.open()
for lvl in (1,2):
    pg=doc.new_page(width=1190,height=842)
    K=0.45
    T=lambda p:(275+(p[0]-80)*K, 310+(p[1]-110)*K)
    def wall(a,b,t=6):
        (ax,ay),(bx,by)=T(a),T(b)
        h=ay==by
        r=fitz.Rect(min(ax,bx)-(0 if h else t/2),min(ay,by)-(t/2 if h else 0),max(ax,bx)+(0 if h else t/2),max(ay,by)+(t/2 if h else 0))
        pg.draw_rect(r,color=(0,0,0),width=0.5)
    def door(x,y,sgn,w=34):
        pg.draw_line(T((x,y)),T((x,y+sgn*w)),color=(0,0,0),width=0.35)
        pts=[T((x+w*math.cos(t*math.pi/20), y+sgn*w*math.sin(t*math.pi/20))) for t in range(11)]
        pg.draw_polyline(pts,color=(0,0,0),width=0.35)
    def text(x,y,s,size=6): pg.insert_text(T((x,y)),s,fontname="china-s",fontsize=size)
    X0,Y0,X1,Y1=80,110,1110,730; C0,C1=360,460
    wall((X0,Y0),(X1,Y0)); wall((X0,Y1),(X1,Y1)); wall((X0,Y0),(X0,C0)); wall((X0,C1),(X0,Y1)); wall((X1,Y0),(X1,Y1))
    if lvl==1: wall((X0,C0),(X0,C0))  # west entrance stays open on 1F
    else: wall((X0,C0),(X0,C1))
    top=[80,250,400,560,720,880,1000,1110]   # 7 rooms; 880-1000 = elevator+stair block
    bot=[80,300,470,640,820,1110]
    names=iter(NAMES[lvl])
    for xs,(ty,by),sgn in ((top,(Y0,C0),-1),(bot,(C1,Y1),1)):
        cy=C0 if sgn<0 else C1
        for i in range(len(xs)-1):
            a,b=xs[i],xs[i+1]
            if i: wall((a,ty),(a,by))
            d=a+ (b-a)//2 - 17
            wall((a,cy),(d,cy)); wall((d+34,cy),(b,cy)); door(d,cy,sgn)
            if xs is top and a==880:
                # elevator shaft with X, stair beside it
                wall((890,140),(950,140)); wall((890,140),(890,250)); wall((950,140),(950,250)); wall((890,250),(950,250))
                pg.draw_line(T((890,140)),T((950,250)),width=0.4); pg.draw_line(T((950,140)),T((890,250)),width=0.4)
                text(905,200,"电梯",8)
                for k in range(6): pg.draw_line(T((958,150+k*12)),T((992,150+k*12)),width=0.4)
                text(962,290,"楼梯",8)
                continue
            n=next(names); text((a+b)/2-len(n)*6.5,(ty+by)/2+5,n)
    text(560,415,"走廊",8)
    pg.insert_text((520,800),f"{'一' if lvl==1 else '二'}层平面图 1:200",fontname="china-s",fontsize=18)
doc.save('/workspace/repro/cad-2f.pdf')
