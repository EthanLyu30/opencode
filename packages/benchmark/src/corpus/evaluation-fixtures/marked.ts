export function markedFixture(): Readonly<Record<string, string>> {
  return {
    ".task24/marked-probe.js": `import marked from '../lib/marked.js';export function facts(source){const html=marked(source);return {checkboxes:Array.from(html.matchAll(/<input\\b[^>]*>/g),m=>/checked=/.test(m[0])),checkboxParagraphs:Array.from(html.matchAll(/<p>\\s*<input\\b/g)).length,lists:Array.from(html.matchAll(/<ul>/g)).length,text:html.replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim()}}\n`,
    ".task24/preview.html": `<!doctype html><meta charset="utf-8"><title>Markdown task</title><button type="button" aria-expanded="true" onclick="const content=document.getElementById('content');content.hidden=!content.hidden;this.setAttribute('aria-expanded',String(!content.hidden));this.textContent=content.hidden?'Show content':'Hide content'">Hide content</button><main id="content"></main><script src="../lib/marked.js"></script><script>document.getElementById('content').innerHTML=marked('- [ ] first\\n\\n- [x] second\\n  - nested\\n\\n- ordinary');</script>`,
  }
}
