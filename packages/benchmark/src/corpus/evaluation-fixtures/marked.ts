export function markedFixture(): Readonly<Record<string, string>> {
  return {
    ".task24/preview.html": `<!doctype html><meta charset="utf-8"><title>Markdown task</title><main id="content"></main><script src="../lib/marked.js"></script><script>document.getElementById('content').innerHTML=marked('- [ ] first\\n\\n- [x] second\\n  - nested\\n\\n- ordinary');</script>`,
  }
}
