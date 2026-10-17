export function design2codeFixture(): Readonly<Record<string, string>> {
  return {
    ".task24/build.ts": `import fs from "node:fs/promises";await fs.mkdir(".task24-build");for(const f of await fs.readdir(".")){if(f.startsWith("."))continue;await fs.cp(f,".task24-build/"+f,{recursive:true,errorOnExist:true,force:false})}\n`,
  }
}
