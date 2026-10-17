export function design2codeFixture(): Readonly<Record<string, string>> {
  return {
    ".task24/page-probe.js": `export const text=selector=>document.querySelector(selector)?.textContent.replace(/\\s+/g," ").trim()??null;
export const images=()=>Array.from(document.images).map(image=>({src:image.getAttribute("src"),loaded:image.complete&&image.naturalWidth>0}));
export const imageHealth=()=>({count:document.images.length,loaded:Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)});
export const localLinks=()=>Array.from(document.querySelectorAll('a[href^="#"]')).map(a=>a.getAttribute('href')).sort();
export const health=()=>document.readyState==="complete"&&document.body.textContent.trim().length>0;
`,
    ".task24/build.ts": `import fs from "node:fs/promises";await fs.mkdir(".task24-build");for(const f of await fs.readdir(".")){if(f.startsWith("."))continue;await fs.cp(f,".task24-build/"+f,{recursive:true,errorOnExist:true,force:false})}\n`,
  }
}
