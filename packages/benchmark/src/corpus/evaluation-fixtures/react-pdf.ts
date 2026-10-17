export function reactPdfFixture(): Readonly<Record<string, string>> {
  return {
    ".task24/preview.html": `<!doctype html><meta charset="utf-8"><title>PDF renderer task</title><style>img{max-width:100%;height:auto}</style><button type="button" aria-expanded="true" onclick="const image=document.querySelector('img');image.hidden=!image.hidden;this.setAttribute('aria-expanded',String(!image.hidden));this.textContent=image.hidden?'Show document':'Hide document'">Hide document</button><img src="document.png" alt="Candidate PDF raster">`,
    ".task24/pdf-probe.js": `import React from 'react';import {Document,Page,Text,View,renderToStream} from '../packages/renderer/lib/react-pdf.cjs.js';
export async function alphaFacts(element,property,color){const Component=element==='Text'?Text:View;const content=element==='Text'?'Alpha text':React.createElement(Text,null,'View text');const doc=React.createElement(Document,null,React.createElement(Page,null,React.createElement(Component,{style:{[property]:color}},content)));const stream=await renderToStream(doc);const parts=[];for await(const part of stream)parts.push(part);const pdf=Buffer.concat(parts).toString('latin1');return [...new Set(Array.from(pdf.matchAll(/\\/ca\\s+([0-9.]+)/g),m=>Number(m[1])).filter(n=>n!==1))].sort((a,b)=>a-b)}
`,
    ".task24/render.jsx": `import React from 'react';import {Document,Page,Text,View,renderToFile} from '../packages/renderer/lib/react-pdf.cjs.js';
const document=<Document><Page><Text style={{color:'rgba(255,0,0,0.5)'}}>Text alpha</Text><View style={{backgroundColor:'rgba(0,0,255,0.5)'}}><Text>View alpha</Text></View><Text style={{color:'black'}}>Solid text</Text></Page></Document>;
await renderToFile(document,'.task24/document.pdf');\n`,
  }
}
