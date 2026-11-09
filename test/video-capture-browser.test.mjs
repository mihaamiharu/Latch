import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {attachmentFixture,valueOf} from './helpers/attachment-fixture.mjs';
import {popupApp} from './fixtures/popup-app.mjs';
import {pngDecoder} from './helpers/evidence-capture.mjs';
import {command} from './helpers/native-browser.mjs';

test('headless native foreground video contains decodable changed frames', {
 skip:process.env.LATCH_VIDEO_CAPTURE!=='1'||process.platform!=='darwin',timeout:150000,
},async t=>{
 const app=await popupApp();let f;t.after(async()=>{await f?.close();await app.close()});
 f=await attachmentFixture(t,app,'native');await f.connect(0,f.tabs[0],{background:true});await f.pw(0,['run-code','async(page)=>page.bringToFront()']);
 const video=path.join(f.evidence,'exploration.webm');
 const start=await f.pw(0,['video-start',video]);await fs.writeFile(path.join(f.evidence,'video-start.json'),JSON.stringify(start,null,2));
 await f.pw(0,['run-code','async(page)=>{await page.evaluate(()=>document.body.style.background="rgb(255,0,0)");await page.waitForTimeout(700);await page.getByRole("textbox").fill("video-proof");await page.getByRole("button",{name:"Save"}).click();await page.evaluate(()=>document.body.style.background="rgb(0,0,255)");await page.waitForTimeout(700)}']);
 const stopped=await f.pw(0,['video-stop']);await fs.writeFile(path.join(f.evidence,'video-stop.json'),JSON.stringify(stopped,null,2));
 assert.ok((await fs.stat(video)).size>1000);

 const ffmpeg=path.join(os.homedir(),'Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac');
 const decoded=await command(ffmpeg,['-i',video,'-f','image2',path.join(f.evidence,'decoded-%03d.png')]);
 assert.equal(decoded.code,0,decoded.err);const files=(await fs.readdir(f.evidence)).filter(n=>/^decoded-.*png$/.test(n));assert.ok(files.length>5);
 const PNG=await pngDecoder();const colours=new Set();
 for(const name of files){const img=PNG.sync.read(await fs.readFile(path.join(f.evidence,name)));let red=0,blue=0;for(let i=0;i<img.data.length;i+=4){const [r,g,b]=img.data.subarray(i,i+3);if(r>180&&g<80&&b<80)red++;if(b>180&&r<80&&g<80)blue++;}if(red>10000)colours.add('red');if(blue>10000)colours.add('blue');}
 assert.deepEqual([...colours].sort(),['blue','red']);
 await fs.writeFile(path.join(f.evidence,'video-capability.json'),JSON.stringify({headless:true,versions:f.versions,launchArgs:f.launchArgs,decoded:true,changedFrames:true,focusPolicy:'explicit foreground; background/popup recording not claimed',start,stopped},null,2));
 console.log('Video evidence: '+f.evidence);
});
