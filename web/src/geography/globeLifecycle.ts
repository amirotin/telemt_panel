type FrameEnvironment={request:(fn:FrameRequestCallback)=>number;cancel:(id:number)=>void};
export function createFrameScheduler(draw:(time:number)=>boolean,env:FrameEnvironment={request:fn=>requestAnimationFrame(fn),cancel:id=>cancelAnimationFrame(id)}){
  let frame:number|null=null,last=-Infinity,active=true,disposed=false;
  function request(){if(!disposed&&active&&frame===null)frame=env.request(tick)}
  function tick(time:number){frame=null;if(disposed||!active)return;if(time-last<1000/30){request();return}last=time;if(draw(time))request()}
  function stop(){if(frame!==null)env.cancel(frame);frame=null}
  return {request,setActive:(enabled:boolean)=>{active=enabled;if(!enabled)stop()},dispose:()=>{disposed=true;stop()}};
}
