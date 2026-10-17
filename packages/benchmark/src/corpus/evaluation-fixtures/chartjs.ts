export function chartjsFixture(legend:boolean):Readonly<Record<string,string>> {
  return {".task24/preview.html":`<!doctype html><meta charset="utf-8"><title>Chart task</title><canvas id="chart" width="600" height="400"></canvas><script src="../dist/chart.js"></script><script>
const canvas=document.getElementById('chart');window.task24State={hover:0,leave:0};
window.task24Chart=new Chart(canvas,{type:'bar',data:{labels:['Zero','Positive'],datasets:[{label:'Series',data:[0,10],minBarLength:50,borderRadius:100,borderSkipped:false}]},options:{animation:false,plugins:{legend:{onHover(){window.task24State.hover++},onLeave(){window.task24State.leave++}}}}});
${legend?"window.task24Events=['mousemove','mouseleave'];":""}
</script>`}
}
