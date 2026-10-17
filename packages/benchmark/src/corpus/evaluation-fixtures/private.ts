// Public infrastructure only. No answer, private test or candidate implementation.
export function privateFixture(modules: readonly string[]): Readonly<Record<string, string>> {
  return {
    ".task24/probe.js": `${modules.map((m) => `export * from "../${m}";`).join("\n")}\nexport function task24Set(object,key,value){if(["__proto__","prototype","constructor"].includes(key))throw new TypeError("unsafe key");object[key]=value;return object}\n`,
    ".task24/smoke.test.ts": `import {test,expect} from "bun:test";\n${modules.map((m, i) => `import * as module${i} from "../${m}";test("public module ${i}",()=>expect(Object.keys(module${i}).length).toBeGreaterThan(0));`).join("\n")}\n`,
    ".task24/build.ts": `import fs from "node:fs/promises";\nawait fs.mkdir(".task24-build",{recursive:true});\nfor(const file of ["index.html","styles.css","app.js","src","assets"]){try{await fs.cp(file,".task24-build/"+file,{recursive:true,errorOnExist:true,force:false})}catch(e){if(e.code!=="ENOENT")throw e}}\n`,
  }
}
