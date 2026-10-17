export function reactPdfFixture():Readonly<Record<string,string>> {
  return {".task24/render.jsx":`import React from 'react';import {Document,Page,Text,View,renderToFile} from '../packages/renderer/lib/react-pdf.cjs.js';
const document=<Document><Page><Text style={{color:'rgba(255,0,0,0.5)'}}>Text alpha</Text><View style={{backgroundColor:'rgba(0,0,255,0.5)'}}><Text>View alpha</Text></View><Text style={{color:'black'}}>Solid text</Text></Page></Document>;
await renderToFile(document,'.task24/document.pdf');\n`}
}
