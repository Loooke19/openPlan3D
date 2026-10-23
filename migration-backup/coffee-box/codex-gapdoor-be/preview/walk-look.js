export class WalkLook {
  constructor() { this.reset(); }
  reset() { this.yaw=0; this.pitch=0; this.pointer=null; }
  begin(id,x,y) { if(this.pointer!==null)return false;this.pointer=id;this.x=x;this.y=y;return true; }
  move(id,x,y) {
    if(id!==this.pointer)return;
    this.yaw=Math.max(-Math.PI*.85,Math.min(Math.PI*.85,this.yaw-(x-this.x)*.005));
    this.pitch=Math.max(-.65,Math.min(.65,this.pitch-(y-this.y)*.004));
    this.x=x;this.y=y;
  }
  end(id) { if(id===this.pointer)this.pointer=null; }
  update(delta) {
    if(this.pointer!==null)return;
    // Return over roughly three times the previous duration; looking around should
    // remain readable after release instead of snapping back immediately.
    const decay=Math.exp(-3*Math.max(0,delta));
    this.yaw*=decay;this.pitch*=decay;
    if(Math.abs(this.yaw)<.0005)this.yaw=0;
    if(Math.abs(this.pitch)<.0005)this.pitch=0;
  }
}
