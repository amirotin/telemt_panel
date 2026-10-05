import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,describe,expect,it} from 'vitest';
import {UpdateTarget,type UpdateTargetProps} from './UpdateTarget';
import {client as apiClient} from '../../lib/api/generated/client.gen';

let root:Root|undefined,container:HTMLDivElement,client:QueryClient,props:UpdateTargetProps;
const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.replace(/[→⌄]/g,'').trim()===name)!;
async function click(name:string){await act(async()=>button(name).click());}
async function render(){await act(async()=>root!.render(<QueryClientProvider client={client}><UpdateTarget {...props}/></QueryClientProvider>));}
async function setup(){
 client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});container=document.createElement('div');document.body.append(container);root=createRoot(container);
 props={target:'panel',data:{target:'panel',current_version:'1.0.0',releases:[{version:'1.0.1',published_at:'2026-09-19T00:00:00Z',prerelease:false,newer:true,checksum_required:true,checksum_available:true}]},lockHeld:false,hostCaps:{self_update:true,restart_telemt:true,restart_panel:true,log_tail:true,log_stream:true},manualCommands:undefined,sseEvent:null,streamFallback:false,onApplied:()=>{}};
 await render();await click('Выбрать версию');await act(async()=>document.querySelector<HTMLInputElement>('input[type=radio]')!.click());await click('Выбрать');await click('Продолжить');
}
afterEach(()=>{if(root)act(()=>root!.unmount());container?.remove();client?.clear();root=undefined;});

describe('release confirmation stays bound to what the operator reviewed',()=>{
 it('blocks a panel checksum that disappears after confirmation',async()=>{
  await setup();props={...props,data:{...props.data,releases:props.data.releases.map(r=>({...r,checksum_available:false}))}};
  await render();expect(button('Обновить панель').disabled).toBe(true);expect(document.body.textContent).toContain('контрольной суммы');
 });
 it('warns when the selected Telemt release has no optional checksum',async()=>{
  await setup();props={...props,target:'telemt',data:{...props.data,target:'telemt',releases:props.data.releases.map(r=>({...r,checksum_required:false,checksum_available:false}))}};
  await render();expect(document.body.textContent).toContain('проверить целостность');
 });
 it('blocks a changed installed version',async()=>{await setup();props={...props,data:{...props.data,current_version:'1.0.2'}};await render();expect(button('Обновить панель').disabled).toBe(true);expect(document.body.textContent).toContain('Выберите версию заново');});
 it('blocks a removed release',async()=>{await setup();props={...props,data:{...props.data,releases:[]}};await render();expect(button('Обновить панель').disabled).toBe(true);});
 it('blocks a newly held lock',async()=>{await setup();props={...props,lockHeld:true};await render();expect(button('Обновить панель').disabled).toBe(true);});
 it('requires a new confirmation if the release becomes a prerelease',async()=>{await setup();props={...props,data:{...props.data,releases:props.data.releases.map(r=>({...r,prerelease:true}))}};await render();expect(button('Обновить панель').disabled).toBe(true);});
});

describe('update progress stays bound to the latest run',()=>{
 it('ignores a previous rollback event while the current run installs',async()=>{
  await setup();
  props={...props,lockHeld:true,data:{...props.data,active_run:{target:'panel',run_id:'current',phase:'installing',version_to:'1.0.1',started_at:'2026-10-03T10:00:00Z'}},sseEvent:{target:'panel',run_id:'previous',phase:'rolled_back',version_to:'1.0.0',started_at:'2026-10-02T10:00:00Z',detail:'previous restart error'}};
  await render();
  expect(document.body.textContent).not.toContain('previous restart error');
  expect(document.body.textContent).toContain('Установка');
 });
 it('keeps the current failure detail after the active run disappears',async()=>{
  await setup();
  props={...props,data:{...props.data,journal:[{target:'panel',run_id:'current',phase:'failed',version_to:'1.0.1',started_at:'2026-10-03T10:00:05Z',detail:'rollback restore failed: permission denied'}]},sseEvent:{target:'panel',run_id:'current',phase:'installing',version_to:'1.0.1',started_at:'2026-10-03T10:00:00Z'}};
  await render();
  expect(document.body.textContent).toContain('rollback restore failed: permission denied');
 });
 it('keeps watching readiness when the witnessed run reconciles to done',async()=>{
  const original=apiClient.getConfig();
  apiClient.setConfig({baseUrl:'http://localhost',fetch:()=>new Promise(()=>{})});
  try{
   await setup();
   const run={target:'panel' as const,run_id:'current',phase:'installing' as const,version_to:'1.0.1',started_at:'2026-10-03T10:00:00Z'};
   props={...props,data:{...props.data,active_run:run}};await render();
   props={...props,data:{...props.data,active_run:undefined,journal:[{...run,phase:'done',started_at:'2026-10-03T10:00:05Z'}]}};await render();
   expect(document.body.textContent).toContain('Панель перезапускается…');
  }finally{apiClient.setConfig(original);}
 });
});
