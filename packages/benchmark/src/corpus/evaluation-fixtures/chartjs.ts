export function chartjsFixture(legend: boolean): Readonly<Record<string, string>> {
  return {
    ".task24/preview.html": `<!doctype html><meta charset="utf-8"><title>Chart task</title><canvas id="chart" width="600" height="400"></canvas><script src="../dist/chart.js"></script><script>
const canvas=document.getElementById('chart');window.task24State={hover:0,leave:0};
window.task24CreateChart=()=>{window.task24Chart?.destroy();window.task24State={hover:0,leave:0};return window.task24Chart=new Chart(canvas,{type:'bar',data:{labels:['Zero','Positive'],datasets:[{label:'Series',data:[0,10],minBarLength:50,borderRadius:100,borderSkipped:false}]},options:{animation:false,plugins:{legend:{onHover(){window.task24State.hover++},onLeave(){window.task24State.leave++}}}}});};window.task24CreateChart();
${legend ? "window.task24Events=['mousemove','mouseleave'];" : ""}
</script><button type="button" aria-pressed="false" onclick="const hidden=!window.task24Chart.getDataVisibility(0);window.task24Chart.toggleDataVisibility(0);window.task24Chart.update('none');this.setAttribute('aria-pressed',String(!hidden));this.textContent=hidden?'Hide zero series':'Show zero series'">Hide zero series</button>`,
    ".task24/chart-probe.js": `export function barFact(field,options={}){const chart=window.task24CreateChart();Object.assign(chart.data.datasets[0],options);chart.update('none');const meta=chart.getDatasetMeta(0),bar=meta.data[0],scale=chart.scales.y;const min=Math.min(scale.getPixelForDecimal(0),scale.getPixelForDecimal(1)),max=Math.max(scale.getPixelForDecimal(0),scale.getPixelForDecimal(1));const facts={overflow:Math.max(0,min-bar.base,bar.base-max),height:Math.abs(bar.base-bar.y),borderSkipped:bar.options.borderSkipped,value:meta.controller.getParsed(1).y};return facts[field]}
export function legendTrace(events){const chart=window.task24CreateChart(),legend=chart.legend,box=legend.legendHitBoxes[0];const values=[];for(const event of events){legend.handleEvent(event==='hover'?{type:'mousemove',x:box.left+box.width/2,y:box.top+box.height/2}:{type:'mouseout',x:-100,y:-100});values.push({...window.task24State})}return values}
`,
  }
}
