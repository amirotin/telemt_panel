import {test,expect,openUsersSearch} from './fixtures';

for(const width of [390,1280]){
 test(`user search belongs to the Users section (${width}px)`,async({page,login})=>{
   await page.setViewportSize({width,height:900});await login();
   const search=await openUsersSearch(page);await search.fill('alice');
   const online=page.getByRole('tab',{name:/^Онлайн/});await online.click();
   const row=page.getByTestId('user-card-alice');await expect(row).toBeVisible();await row.click();
   await page.getByRole('link',{name:'Назад',exact:true}).click();await expect(search).toHaveValue('alice');
   await expect(online).toHaveAttribute('aria-selected','true');
   await page.locator('a[href="/overview"]:visible').first().click();await page.locator('a[href="/people"]:visible').first().click();
   await openUsersSearch(page);
   await expect(search).toHaveValue('');
   await expect(page.getByRole('tab',{name:/^Все/})).toHaveAttribute('aria-selected','true');
   await search.fill('no-such-person');await page.getByRole('button',{name:'Очистить поиск',exact:true}).click();
   await expect(search).toHaveValue('');await expect(search).toBeFocused();await expect(row).toBeVisible();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 });
}
