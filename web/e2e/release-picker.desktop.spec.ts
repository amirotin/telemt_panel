import {test,expect} from './fixtures';

for(const width of [320,390,768,1280,2560]){
 test(`select and confirm a release without changing automatic policy (${width}px)`,async({page,login},testInfo)=>{
   await login();await page.setViewportSize({width,height:960});
   let locked=false,catalogError=false,olderOnly=false,manual=false,current='3.5.5';const applied:Array<{target:string;version:string}>=[];
   await page.route('**/api/host',async route=>{const data=await(await route.fetch()).json();data.caps.self_update=!manual;await route.fulfill({json:data});});
   await page.route('**/api/updates',route=>route.fulfill({json:{lock_held:locked,targets:[
     {target:'telemt',current_version:current,releases_error:catalogError?'update_catalog_unavailable':undefined,releases:catalogError?[]:[{version:'3.5.7',published_at:'2026-09-17T00:00:00Z',prerelease:false,newer:true},{version:'3.5.4',published_at:'2026-09-09T00:00:00Z',prerelease:false,newer:false}].filter(r=>!olderOnly||!r.newer),journal:[]},
     {target:'panel',current_version:'1.0.0-rc.1',checksum_required:true,releases:[{version:'1.0.0-rc.2',published_at:'2026-09-18T00:00:00Z',prerelease:true,newer:true,checksum_required:true,checksum_available:true},{version:'1.0.0-beta.1',published_at:'2026-09-09T00:00:00Z',prerelease:true,newer:false,checksum_required:true,checksum_available:true}],journal:[]},
   ]}}));
   await page.route('**/api/updates/*/apply',route=>{applied.push({target:new URL(route.request().url()).pathname.split('/')[3]!,version:route.request().postDataJSON().version});return route.fulfill({status:202});});
   const policyWrites:string[]=[];page.on('request',r=>{if(r.method()==='PUT'&&r.url().includes('/api/updates/auto'))policyWrites.push(r.url());});
   await page.goto('/server/updates');const telemt=page.locator('[data-update-target="telemt"]');await telemt.getByRole('button',{name:'Выбрать версию',exact:true}).click();
   const dialog=page.getByRole('dialog');await dialog.getByRole('radio',{name:/3\.5\.4/}).check();await page.screenshot({path:testInfo.outputPath('release-list.png')});await dialog.getByRole('button',{name:'Выбрать',exact:true}).click();expect(applied).toEqual([]);await page.screenshot({path:testInfo.outputPath('selected-version.png')});
   await telemt.getByRole('button',{name:'Продолжить',exact:true}).click();const apply=dialog.getByRole('button',{name:'Откатить Telemt',exact:true});await expect(apply).toBeDisabled();await dialog.getByRole('checkbox',{name:/резервн/i}).check();
   await page.screenshot({path:testInfo.outputPath('rollback-confirm.png')});await apply.click();await expect.poll(()=>applied).toEqual([{target:'telemt',version:'3.5.4'}]);expect(policyWrites).toEqual([]);
   const panel=page.locator('[data-update-target="panel"]');await panel.getByRole('button',{name:'Выбрать версию',exact:true}).click();await dialog.getByRole('checkbox',{name:'Предварительные выпуски'}).check();await dialog.getByRole('radio',{name:/1\.0\.0-rc\.2/}).check();await dialog.getByRole('button',{name:'Выбрать',exact:true}).click();await panel.getByRole('button',{name:'Продолжить',exact:true}).click();await expect(dialog).toContainText('Предварительный выпуск');await page.keyboard.press('Escape');expect(applied).toHaveLength(1);
   locked=true;await page.reload();await expect(telemt.getByRole('button',{name:'Выбрать версию',exact:true})).toBeDisabled();
   locked=false;await expect(telemt.getByRole('button',{name:'Выбрать версию',exact:true})).toBeEnabled({timeout:7000});
   locked=false;catalogError=true;await page.reload();await expect(telemt).toContainText('Не удалось получить список');await expect(telemt.getByRole('button',{name:'Выбрать версию',exact:true})).toHaveCount(0);
   catalogError=false;olderOnly=true;current='3.5.7';await page.reload();await telemt.getByRole('button',{name:'Выбрать версию',exact:true}).click();await expect(dialog.getByRole('radio',{name:/3\.5\.4/})).toBeVisible();await page.keyboard.press('Escape');
   manual=true;await page.reload();await telemt.getByRole('button',{name:'Выбрать версию',exact:true}).click();await dialog.getByRole('radio',{name:/3\.5\.4/}).check();await dialog.getByRole('button',{name:'Выбрать',exact:true}).click();await expect(telemt).toContainText('Установка вручную');await expect(telemt.getByRole('button',{name:'Продолжить',exact:true})).toHaveCount(0);expect(applied).toHaveLength(1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 });
}
