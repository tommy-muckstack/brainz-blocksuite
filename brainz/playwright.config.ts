import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests', timeout:45000, fullyParallel:false, workers:1,
  use:{baseURL:'http://127.0.0.1:5178',viewport:{width:1280,height:850},launchOptions:process.env.BRAINZ_TEST_BROWSER ? {executablePath:process.env.BRAINZ_TEST_BROWSER} : {}},
  webServer:{command:'npm run dev',url:'http://127.0.0.1:5178',reuseExistingServer:true},
});
