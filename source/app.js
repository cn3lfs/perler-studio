'use strict';
/** 格序: the model is the source of truth. A cell stores exactly one MARD code or null.
 * Reference imagery is never included in a production export.
 * Palette RGB: MakeBead craft-color-codes, CC-BY-4.0 (community, not official calibration).
 */
(() => {
 const $ = id => document.getElementById(id);
 const NS = 'http://www.w3.org/2000/svg';
 const BLUE = '#2563EB', CELL = 32, MARGIN = 64, MAJOR = 5;
 const SEAM = '#E11D48', MIN_SIDE = 5, MAX_SIDE = 156, BEAD_MM = [2.5,2.6,5,10];
 /** Peg boards sold in China: pegs per side and the bead diameter they are made for. */
 const BOARDS = {52:{mm:2.6},29:{mm:5}};
 const FAMILY = {A:'黄橙',B:'绿色',C:'蓝青',D:'紫色',E:'粉色',F:'红色',G:'棕肤',H:'黑白灰',M:'柔和色'};
 const KNOWN = new Set(BASE_PALETTE.map(c=>c.code));
 const clone = x => JSON.parse(JSON.stringify(x));
 const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const normalize = code => { const m=String(code||'').trim().toUpperCase().match(/^([A-HM])0*(\d+)$/); return m?m[1]+Number(m[2]):null; };
 const canonical = code => { const c=normalize(code); if(!KNOWN.has(c)) throw Error('未知色号：'+code); return c; };
 let palette=clone(BASE_PALETTE), paletteMap=new Map();
 let state={cols:52,rows:52,mm:2.6,boardW:52,boardH:52,title:'我的拼豆图纸',majorStyle:'dashed',cells:Array(52*52).fill(null),paletteStatus:'community',revision:0};
 let selected='H7', tool='draw', family='all', zoom=1, highlight=false, componentsCache=null;
 let undoStack=[],redoStack=[],drawing=false,changed=false,lastPoint=null,panStart=null,paintFrame=null,cacheTimer=null;
 let reference={img:null,data:'',name:'内置示例',crop:clone(BUILTIN_CROP),fit:'contain'},cropTemp=null,cropStart=null;
 let toastTimer, activePointer=null;
 const storageKey='bead-grid-studio-v1';
 function toast(message,error=false){$('toast').textContent=message;$('toast').className='toast visible'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4500);}
 function guard(fn){return async (...args)=>{try{return await fn(...args);}catch(e){console.error(e);toast(e.message||String(e),true);}};}
 function setPalette(colors){palette=colors.map(c=>({code:canonical(c.code),hex:c.hex.toUpperCase()}));paletteMap=new Map(palette.map(c=>[c.code,c]));}
 function hexRgb(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}
 function contrast(hex){const [r,g,b]=hexRgb(hex);return (.2126*r+.7152*g+.0722*b)>148?'#17232A':'#FFFFFF';}
 function rgbToLab(rgb){let [r,g,b]=rgb.map(v=>{v/=255;return v>.04045?((v+.055)/1.055)**2.4:v/12.92;});let a=[(r*.4124564+g*.3575761+b*.1804375)/.95047,(r*.2126729+g*.7151522+b*.072175),(r*.0193339+g*.119192+b*.9503041)/1.08883].map(v=>v>.008856?Math.cbrt(v):7.787*v+16/116);return [116*a[1]-16,500*(a[0]-a[1]),200*(a[1]-a[2])];}
 function neighbors(i,cols=state.cols,rows=state.rows){const out=[],x=i%cols,y=Math.floor(i/cols);if(x>0)out.push(i-1);if(x+1<cols)out.push(i+1);if(y>0)out.push(i-cols);if(y+1<rows)out.push(i+cols);return out;}
 function components(cells=state.cells,cols=state.cols,rows=state.rows){const seen=new Uint8Array(cells.length),groups=[];for(let i=0;i<cells.length;i++){if(!cells[i]||seen[i])continue;const q=[i];seen[i]=1;for(let k=0;k<q.length;k++)for(const j of neighbors(q[k],cols,rows))if(cells[j]&&!seen[j]){seen[j]=1;q.push(j);}groups.push(q);}groups.sort((a,b)=>b.length-a.length);return groups;}
 function currentComponents(){if(!componentsCache)componentsCache=components();return componentsCache;}
 const validSide=n=>Number.isInteger(n)&&n>=MIN_SIDE&&n<=MAX_SIDE;
 /** Cells per blue-line interval: all 5, except a shorter last one when the side is not a multiple of 5. */
 function intervals(n){const out=[];for(let i=0;i<n;i+=MAJOR)out.push(Math.min(MAJOR,n-i));return out;}
 /** Peg-board layout. Without a board preset the whole grid counts as one board and no seams are drawn. */
 function boards(){const bw=state.boardW||state.cols,bh=state.boardH||state.rows;return {bw,bh,nx:Math.ceil(state.cols/bw),ny:Math.ceil(state.rows/bh),seams:!!state.boardW};}
 const mmText=n=>String(+(n*state.mm).toFixed(1));
 function viewCells(v){const out=[];for(let r=0;r<v.rows;r++)for(let c=0;c<v.cols;c++)out.push(state.cells[(v.r0+r)*state.cols+v.c0+c]);return out;}
 function usage(cells=state.cells){const c={};for(const code of cells)if(code)c[code]=(c[code]||0)+1;return Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],undefined,{numeric:true}));}
 function modelChanged(){state.revision++;componentsCache=null;scheduleCache();}
 function snapshot(){return {state:clone(state),palette:clone(palette)};}
 function pushUndo(){undoStack.push(snapshot());if(undoStack.length>60)undoStack.shift();redoStack=[];}
 function restoreSnapshot(s){state=clone(s.state);setPalette(s.palette);componentsCache=null;syncSettings();renderPalette();renderAll();scheduleCache();}
 function undo(){if(!undoStack.length)return;redoStack.push(snapshot());restoreSnapshot(undoStack.pop());}
 function redo(){if(!redoStack.length)return;undoStack.push(snapshot());restoreSnapshot(redoStack.pop());}
 function scheduleCache(){clearTimeout(cacheTimer);cacheTimer=setTimeout(()=>{try{localStorage.setItem(storageKey,JSON.stringify({state,palette}));$('saveStatus').textContent='格子已本地缓存 · 请另存工程';}catch{$('saveStatus').textContent='浏览器未允许缓存 · 请保存工程';}},500);}
 function geometry(cols=state.cols,rows=state.rows){return {cell:CELL,m:MARGIN,w:cols*CELL+2*MARGIN,h:rows*CELL+2*MARGIN,xEdges:Array.from({length:cols+1},(_,i)=>MARGIN+i*CELL),yEdges:Array.from({length:rows+1},(_,i)=>MARGIN+i*CELL)};}
 function audit(){const g=geometry(),groups=currentComponents(),counts=usage(),used=counts.reduce((a,b)=>a+b[1],0);const xMajor=g.xEdges.filter((_,i)=>i%MAJOR===0||i===state.cols),yMajor=g.yEdges.filter((_,i)=>i%MAJOR===0||i===state.rows);const xd=xMajor.slice(1).map((v,i)=>(v-xMajor[i])/CELL),yd=yMajor.slice(1).map((v,i)=>(v-yMajor[i])/CELL),b=boards(),regular=(d,n)=>d.join()===intervals(n).join();return {app:'格序 1.1',boardPegs:b.seams?[b.bw,b.bh]:null,boardsNeeded:[b.nx,b.ny],cols:state.cols,rows:state.rows,totalCells:state.cols*state.rows,matrixLength:state.cells.length,verticalBoundaryLines:g.xEdges.length,horizontalBoundaryLines:g.yEdges.length,majorInterval:MAJOR,columnsPerBlueInterval:xd,rowsPerBlueInterval:yd,minorLinesInsideBlueInterval:4,blueX:xMajor,blueY:yMajor,cellSizeInSVG:CELL,nominalBeadMm:state.mm,nominalGridMm:[state.cols*state.mm,state.rows*state.mm],usedBeads:used,emptyCells:state.cells.length-used,colorCount:counts.length,connectedComponents:groups.length,componentSizes:groups.map(a=>a.length),validCodes:state.cells.every(c=>c===null||paletteMap.has(c)),gridValid:state.cells.length===state.rows*state.cols&&regular(xd,state.cols)&&regular(yd,state.rows)&&g.xEdges.length===state.cols+1&&g.yEdges.length===state.rows+1,connectivityPassed:groups.length===1,referenceExcludedFromExport:true,paletteStatus:state.paletteStatus};}
 function imagePlacement(crop=reference.crop,fit=reference.fit){const gw=state.cols*CELL,gh=state.rows*CELL;let w=gw,h=gh;if(fit!=='stretch'){const k=(fit==='cover'?Math.max:Math.min)(gw/crop.w,gh/crop.h);w=crop.w*k;h=crop.h*k;}return {x:MARGIN+(gw-w)/2,y:MARGIN+(gh-h)/2,w,h};}
 function gridSVG({labels=true,grid=true,ref=false,mark=false,legend=false,view=null}={}){
  // view = one peg board cut out of the full matrix; coordinates keep the numbering of the full pattern.
  const full=!view,v=view||{c0:0,r0:0,cols:state.cols,rows:state.rows};
  const base=geometry(v.cols,v.rows),{m,h,cell}=base,w=legend?Math.max(base.w,960):base.w,gw=v.cols*cell,gh=v.rows*cell,entries=full?usage():usage(viewCells(v));
  const legendCols=Math.max(2,Math.min(8,Math.floor((w-2*m)/190)));
  const legendRows=Math.ceil(entries.length/legendCols);
  const extra=legend?230+legendRows*35:0,H=h+extra;
  let s=`<rect width="${w}" height="${H}" fill="#FFFFFF"/>`;
  if(full&&ref&&reference.img){const p=imagePlacement(),c=reference.crop;
   s+=`<defs><clipPath id="ref-clip"><rect x="${m}" y="${m}" width="${gw}" height="${gh}"/></clipPath></defs><g clip-path="url(#ref-clip)" opacity="${Number($('refOpacity').value)/100}"><svg x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" preserveAspectRatio="none"><image href="${reference.data}" width="${reference.img.naturalWidth}" height="${reference.img.naturalHeight}"/></svg></g>`;
  }
  for(let r=0;r<v.rows;r++)for(let c=0;c<v.cols;c++){
   const index=(v.r0+r)*state.cols+v.c0+c,code=state.cells[index],x=m+c*cell,y=m+r*cell;
   if(code){const p=paletteMap.get(code);s+=`<rect data-cell="${index}" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${p.hex}"/>`;if(labels)s+=`<text x="${x+cell/2}" y="${y+cell/2+1}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${cell*.29}" fill="${contrast(p.hex)}">${escape(code)}</text>`;
   }else{s+=`<circle cx="${x+cell/2}" cy="${y+cell/2}" r=".65" fill="#CDD3DA"/>`;}
  }
  if(full&&mark&&highlight){const groups=currentComponents();for(const a of groups.slice(1))for(const i of a){let x=m+(i%state.cols)*cell,y=m+Math.floor(i/state.cols)*cell;s+=`<rect x="${x+2}" y="${y+2}" width="${cell-4}" height="${cell-4}" fill="#FF8A3133" stroke="#F17C17" stroke-width="2"/>`;}}
  if(grid){
   s+=`<g fill="none" stroke="#A3ADB7" stroke-width=".65">`;
   for(let c=0;c<=v.cols;c++)if((v.c0+c)%MAJOR)s+=`<line x1="${m+c*cell}" y1="${m}" x2="${m+c*cell}" y2="${m+gh}"/>`;
   for(let r=0;r<=v.rows;r++)if((v.r0+r)%MAJOR)s+=`<line x1="${m}" y1="${m+r*cell}" x2="${m+gw}" y2="${m+r*cell}"/>`;s+='</g>';
   s+=`<g fill="none" stroke="${BLUE}" stroke-width="1.85"${state.majorStyle==='dashed'?' stroke-dasharray="9 5"':''}>`;
   for(let c=1;c<v.cols;c++)if((v.c0+c)%MAJOR===0)s+=`<line data-major="x-${v.c0+c}" x1="${m+c*cell}" y1="${m}" x2="${m+c*cell}" y2="${m+gh}"/>`;
   for(let r=1;r<v.rows;r++)if((v.r0+r)%MAJOR===0)s+=`<line data-major="y-${v.r0+r}" x1="${m}" y1="${m+r*cell}" x2="${m+gw}" y2="${m+r*cell}"/>`;s+='</g>';
  }
  if(grid&&state.boardW){
   // Peg-board seams: where one physical board ends and the next begins.
   s+=`<g fill="none" stroke="${SEAM}" stroke-width="3.2">`;
   for(let c=1;c<v.cols;c++)if((v.c0+c)%state.boardW===0)s+=`<line data-seam="x-${v.c0+c}" x1="${m+c*cell}" y1="${m}" x2="${m+c*cell}" y2="${m+gh}"/>`;
   for(let r=1;r<v.rows;r++)if((v.r0+r)%state.boardH===0)s+=`<line data-seam="y-${v.r0+r}" x1="${m}" y1="${m+r*cell}" x2="${m+gw}" y2="${m+r*cell}"/>`;s+='</g>';
  }
  s+=`<rect x="${m}" y="${m}" width="${gw}" height="${gh}" fill="none" stroke="${BLUE}" stroke-width="2"/>`;
  // Gray labels are cell indices (centers); blue labels are boundary positions.
  s+='<g font-family="Arial,sans-serif" font-size="11" fill="#647182" text-anchor="middle">';
  for(let c=1;c<=v.cols;c++){let x=m+(c-.5)*cell;s+=`<text x="${x}" y="${m-9}">${v.c0+c}</text><text x="${x}" y="${m+gh+16}">${v.c0+c}</text>`;}
  for(let r=1;r<=v.rows;r++){let y=m+(r-.5)*cell+4;s+=`<text x="${m-15}" y="${y}">${v.r0+r}</text><text x="${m+gw+15}" y="${y}">${v.r0+r}</text>`;}s+='</g>';
  // Blue boundary numbers on every 5th edge, plus the outer edges unless they would crowd a neighbour.
  const boundary=(i,n,origin)=>{const k=(origin+i)%MAJOR;return k===0||(i===0&&k<=3)||(i===n&&k>=2);};
  s+=`<g font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="${BLUE}" text-anchor="middle">`;
  for(let c=0;c<=v.cols;c++)if(boundary(c,v.cols,v.c0))s+=`<text x="${m+c*cell}" y="${m-34}">${v.c0+c}</text><text x="${m+c*cell}" y="${m+gh+44}">${v.c0+c}</text>`;
  for(let r=0;r<=v.rows;r++)if(boundary(r,v.rows,v.r0))s+=`<text x="${m-43}" y="${m+r*cell+5}">${v.r0+r}</text><text x="${m+gw+43}" y="${m+r*cell+5}">${v.r0+r}</text>`;s+='</g>';
  if(legend){const a=audit(),b=boards(),y=h+14,beads=entries.reduce((sum,e)=>sum+e[1],0);
   const heading=full?state.title:`${state.title} · 底板 ${v.by+1}-${v.bx+1}（第 ${v.by+1} 行第 ${v.bx+1} 列，共 ${b.nx*b.ny} 块）`;
   const layout=!b.seams?'':b.nx*b.ny>1?` · 红线 = ${b.bw}×${b.bh} 底板分界（横 ${b.nx} × 纵 ${b.ny} 块）`:` · ${b.bw}×${b.bh} 底板 1 块`;
   const scope=full?` · 连通区域 ${a.connectedComponents} 个`:` · 全图第 ${v.c0+1}–${v.c0+v.cols} 列 / 第 ${v.r0+1}–${v.r0+v.rows} 行`;
   s+=`<g font-family="Arial,'Microsoft YaHei','Noto Sans CJK SC',sans-serif" fill="#243932"><text x="${m}" y="${y}" font-size="24" font-weight="700">${escape(heading)}</text><text x="${m}" y="${y+32}" font-size="15">${v.cols} × ${v.rows} 格 | 豆径 ${state.mm} mm | 成品约 ${mmText(v.cols)} × ${mmText(v.rows)} mm | ${beads} 颗 / ${entries.length} 色</text><text x="${m}" y="${y+57}" font-size="13" fill="#566779">每 5 格一条蓝线${layout}${scope} · 空格不放豆</text>`;
   entries.forEach(([code,n],i)=>{const x=m+(i%legendCols)*((w-2*m)/legendCols),yy=y+82+Math.floor(i/legendCols)*35;s+=`<rect x="${x}" y="${yy-16}" width="23" height="23" fill="${paletteMap.get(code).hex}" stroke="#ABB1B9" stroke-width=".7"/><text x="${x+33}" y="${yy+1}" font-size="14">${code} × ${n}</text>`;});
   const bottom=y+110+legendRows*35,ruleWidth=(50/state.mm)*CELL;
   s+=`<text x="${m}" y="${bottom}" font-size="12" fill="#687671">MARD 221 · 社区参考 RGB；请核对实体色卡。Color data: MakeBead / CC BY 4.0</text><text x="${m}" y="${bottom+24}" font-size="12" fill="#687671">按实际大小打印；下方标尺应为 50 mm。数学连通不等于熨烫强度。</text><path d="M ${m} ${bottom+37} v 10 M ${m} ${bottom+42} h ${ruleWidth} M ${m+ruleWidth} ${bottom+37} v 10" fill="none" stroke="#334F45" stroke-width="1.2"/><text x="${m+ruleWidth+12}" y="${bottom+47}" font-size="12">50 mm</text></g>`;
  }
  return {content:s,w,h:H};
 }
 function renderBoard(){
  // Codes smaller than ~4.5 px on screen are unreadable; leaving them out keeps large boards responsive.
  const scene=gridSVG({labels:$('showCodes').checked&&zoom*CELL*.29>=4.5,grid:$('showGrid').checked,ref:$('showReference').checked,mark:true});const svg=$('board');svg.setAttribute('viewBox',`0 0 ${scene.w} ${scene.h}`);svg.setAttribute('width',scene.w*zoom);svg.setAttribute('height',scene.h*zoom);svg.innerHTML=scene.content;svg.dataset.tool=tool;}
 function renderPalette(){const q=$('paletteSearch').value.toUpperCase().trim(),normalized=normalize(q);const counts=new Map(usage());$('palette').replaceChildren();for(const c of palette){if(family==='used'&&!counts.has(c.code))continue;if(family!=='all'&&family!=='used'&&c.code[0]!==family)continue;if(q&&!c.code.includes(q)&&c.code!==normalized&&!c.hex.includes(q))continue;const b=document.createElement('button');b.type='button';b.className='swatch'+(c.code===selected?' selected':'');b.style.background=c.hex;b.style.color=contrast(c.hex);b.textContent=c.code;b.title=`${c.code} · ${c.hex}${counts.has(c.code)?' · '+counts.get(c.code)+' 颗':''}`;b.setAttribute('aria-label',b.title);b.onclick=()=>selectColor(c.code);$('palette').append(b);}updateCurrent();}
 function updateCurrent(){const p=paletteMap.get(selected);$('currentSwatch').style.background=p.hex;$('currentCode').textContent=p.code;$('currentHex').textContent=p.hex+' · '+FAMILY[p.code[0]]+'系';}
 function selectColor(code){selected=code;renderPalette();}
 function renderStatus(){const a=audit();$('undoBtn').disabled=!undoStack.length;$('redoBtn').disabled=!redoStack.length;$('sizeMetric').textContent=`${(state.cols*state.mm/10).toFixed(1).replace(/\.0$/,'')} × ${(state.rows*state.mm/10).toFixed(1).replace(/\.0$/,'')}`;$('capacityMetric').textContent=(state.cols*state.rows).toLocaleString();$('boardTitle').textContent=state.title;{const b=boards();$('gridBadge').textContent=`${state.cols} × ${state.rows} · ${state.mm} mm`+(b.seams?` · ${b.bw} 板 × ${b.nx*b.ny}`:'');$('boardMetric').textContent=!b.seams?'自定义格数：不画底板分界线。':b.nx*b.ny>1?`需要 ${b.bw}×${b.bh} 底板 ${b.nx*b.ny} 块（横 ${b.nx} × 纵 ${b.ny}），红线为拼板分界。`:`需要 ${b.bw}×${b.bh} 底板 1 块。`;}$('beadCount').textContent=`${a.usedBeads.toLocaleString()} 颗`;$('usedColors').textContent=`${a.colorCount} 色`;
  $('connectStatus').className=a.connectivityPassed?'status-good':a.usedBeads?'status-bad':'';$('connectStatus').textContent=!a.usedBeads?'尚未放豆':a.connectivityPassed?'✓ 所有豆格已连通':`${a.connectedComponents} 个分离部分`;
  $('connectHint').textContent=!a.usedBeads?'先用画笔填色，或从参考图生成初稿。':a.connectivityPassed?'四邻接检测通过。细连接处仍需检查是否足够牢固。':`最大主体 ${a.componentSizes[0]} 颗；其余部分请补桥或填底后再熨烫。`;
  const entries=usage();$('counts').innerHTML=entries.length?`<table><thead><tr><th>色号</th><th>数量 / 颗</th></tr></thead><tbody>${entries.map(([c,n])=>`<tr><td><i class="mini-swatch" style="background:${paletteMap.get(c).hex}"></i>${c}</td><td>${n}</td></tr>`).join('')}<tr><td><b>合计</b></td><td><b>${a.usedBeads}</b></td></tr></tbody></table>`:'<span class="hint">尚无用量数据。</span>';
 }
 function renderAll(){renderBoard();renderStatus();}
 function syncSettings(){const b=boards();$('boardPreset').value=BOARDS[state.boardW]&&state.boardW===state.boardH?String(state.boardW):'0';$('boardsX').value=String(Math.min(3,b.nx));$('boardsY').value=String(Math.min(3,b.ny));$('projectName').value=state.title;$('colsInput').value=state.cols;$('rowsInput').value=state.rows;$('beadSize').value=String(state.mm);$('majorStyle').value=state.majorStyle;}
 function fitView(){const g=geometry();zoom=Math.max(.12,Math.min(1.4,($('viewport').clientWidth-44)/g.w,($('viewport').clientHeight-44)/g.h));$('zoomInput').value=Math.round(zoom*100);$('zoomLabel').textContent=Math.round(zoom*100)+'%';renderBoard();}
 function setTool(t){tool=t;document.querySelectorAll('[data-tool]').forEach(b=>{if(b.tagName==='BUTTON')b.classList.toggle('active',b.dataset.tool===tool);});$('board').dataset.tool=t;}
 function hit(event){const b=$('board').getBoundingClientRect(),g=geometry();let x=(event.clientX-b.left)*g.w/b.width,y=(event.clientY-b.top)*g.h/b.height;let col=Math.floor((x-MARGIN)/CELL),row=Math.floor((y-MARGIN)/CELL);if(col<0||row<0||col>=state.cols||row>=state.rows)return null;return {col,row,index:row*state.cols+col};}
 function paintCell(col,row,value){if(col<0||row<0||col>=state.cols||row>=state.rows)return;const i=row*state.cols+col;if(state.cells[i]!==value){state.cells[i]=value;changed=true;}}
 function drawStroke(a,b,value){let x=a.col,y=a.row,dx=Math.abs(b.col-x),dy=Math.abs(b.row-y),sx=x<b.col?1:-1,sy=y<b.row?1:-1,err=dx-dy;while(true){paintCell(x,y,value);if(x===b.col&&y===b.row)break;const e2=2*err;if(e2>-dy){err-=dy;x+=sx;}if(e2<dx){err+=dx;y+=sy;}}}
 function flood(index,replacement){const old=state.cells[index];if(old===replacement)return;const q=[index];state.cells[index]=replacement;for(let k=0;k<q.length;k++)for(const j of neighbors(q[k]))if(state.cells[j]===old){state.cells[j]=replacement;q.push(j);}changed=true;}
 function requestPaint(){if(paintFrame)return;paintFrame=requestAnimationFrame(()=>{paintFrame=null;componentsCache=null;renderBoard();});}
 $('board').addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();activePointer=e.pointerId;$('board').setPointerCapture(e.pointerId);if(tool==='pan'){panStart={x:e.clientX,y:e.clientY,left:$('viewport').scrollLeft,top:$('viewport').scrollTop};return;}const p=hit(e);if(!p)return;if(tool==='pick'){const c=state.cells[p.index];if(c)selectColor(c);else toast('这一格是空格，没有色号。');return;}pushUndo();drawing=true;changed=false;lastPoint=p;if(tool==='fill'){flood(p.index,selected);}else{paintCell(p.col,p.row,tool==='erase'?null:selected);}requestPaint();});
 $('board').addEventListener('pointermove',e=>{if(panStart){$('viewport').scrollLeft=panStart.left-(e.clientX-panStart.x);$('viewport').scrollTop=panStart.top-(e.clientY-panStart.y);return;}const p=hit(e);if(p){const code=state.cells[p.index];$('cursorStatus').textContent=`列 ${p.col+1} · 行 ${p.row+1} · ${code||'留空'}`;}if(drawing&&p&&tool!=='fill'){drawStroke(lastPoint||p,p,tool==='erase'?null:selected);lastPoint=p;requestPaint();}});
 function endStroke(){if(drawing){drawing=false;if(changed){modelChanged();}else undoStack.pop();renderAll();}panStart=null;lastPoint=null;activePointer=null;}
 $('board').addEventListener('pointerup',endStroke);$('board').addEventListener('pointercancel',endStroke);$('board').addEventListener('lostpointercapture',()=>{if(drawing||panStart)endStroke();});
 document.querySelectorAll('button[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
 $('undoBtn').onclick=undo;$('redoBtn').onclick=redo;$('fitBtn').onclick=fitView;
 $('zoomInput').oninput=()=>{zoom=Number($('zoomInput').value)/100;$('zoomLabel').textContent=Math.round(zoom*100)+'%';renderBoard();};
 for(const id of ['showCodes','showGrid','showReference','refOpacity'])$(id).oninput=renderBoard;
 $('majorStyle').onchange=()=>{state.majorStyle=$('majorStyle').value;renderBoard();scheduleCache();};
 $('projectName').oninput=()=>{state.title=$('projectName').value.trim()||'未命名图纸';renderStatus();scheduleCache();};
 $('beadSize').onchange=()=>{state.mm=Number($('beadSize').value);renderStatus();scheduleCache();};
 function presetChanged(){const side=Number($('boardPreset').value);if(!side)return;$('colsInput').value=side*Number($('boardsX').value);$('rowsInput').value=side*Number($('boardsY').value);}
 $('boardPreset').onchange=()=>{const side=Number($('boardPreset').value);if(side){$('beadSize').value=String(BOARDS[side].mm);$('beadSize').onchange();}presetChanged();};
 $('boardsX').onchange=presetChanged;$('boardsY').onchange=presetChanged;
 $('applyGridBtn').onclick=()=>{const cols=Number($('colsInput').value),rows=Number($('rowsInput').value),side=Number($('boardPreset').value);if(!validSide(cols)||!validSide(rows)){toast(`行列需为 ${MIN_SIDE}–${MAX_SIDE} 之间的整数。`,true);return;}if(state.cells.some(Boolean)&&!confirm('新建会清空当前填色（可撤销）。继续吗？'))return;pushUndo();state.cols=cols;state.rows=rows;state.boardW=state.boardH=side;state.cells=Array(cols*rows).fill(null);highlight=false;modelChanged();syncSettings();renderAll();fitView();const b=boards();toast(`已建立 ${cols}×${rows} 空白网格`+(b.seams?`，需 ${b.bw}×${b.bh} 底板 ${b.nx*b.ny} 块。`:'。'));};
 $('paletteSearch').oninput=renderPalette;
 for(const [key,name] of [['all','全部'],['used','已用'],...Object.keys(FAMILY).map(k=>[k,k])]){const b=document.createElement('button');b.textContent=name;b.className=key==='all'?'active':'';b.onclick=()=>{family=key;[...$('families').children].forEach(x=>x.classList.toggle('active',x===b));renderPalette();};$('families').append(b);}
 $('editColorBtn').onclick=()=>{const hex=prompt(`校正 ${selected} 的屏幕色值（#RRGGBB）。不会更改色号。`,paletteMap.get(selected).hex);if(hex===null)return;if(!/^#[0-9a-f]{6}$/i.test(hex.trim()))return toast('请输入 #RRGGBB 格式。',true);pushUndo();paletteMap.get(selected).hex=hex.trim().toUpperCase();setPalette(palette);state.paletteStatus='user-calibrated';modelChanged();renderPalette();renderAll();};
 $('clearBtn').onclick=()=>{if(!state.cells.some(Boolean))return;if(!confirm('清空全部豆格？可以撤销。'))return;pushUndo();state.cells.fill(null);modelChanged();renderAll();};
 $('fillEmptyBtn').onclick=()=>{const n=state.cells.filter(c=>!c).length;if(!n)return toast('没有空格。');if(!confirm(`用 ${selected} 填满 ${n} 个空格？这会成为满底板，可撤销。`))return;pushUndo();state.cells=state.cells.map(c=>c||selected);modelChanged();renderAll();toast(`已填入 ${n} 颗 ${selected}。`);};
 $('highlightBtn').onclick=()=>{highlight=!highlight;$('highlightBtn').classList.toggle('active',highlight);renderBoard();};
 function autoConnect(width=2){let groups=components(),added=0,iterations=0;if(groups.length<2)return 0;while(groups.length>1&&iterations++<state.cells.length){const main=new Set(groups[0]),visited=new Uint8Array(state.cells.length),prev=new Int32Array(state.cells.length).fill(-1),q=[...main];for(const i of q)visited[i]=1;let target=-1;for(let k=0;k<q.length&&target<0;k++){for(const j of neighbors(q[k])){if(visited[j])continue;visited[j]=1;prev[j]=q[k];q.push(j);if(state.cells[j]&&!main.has(j)){target=j;break;}}}if(target<0)break;const path=[];let i=target;while(i>=0&&!main.has(i)){path.push(i);i=prev[i];}if(i>=0)path.push(i);for(let k=0;k<path.length;k++){const p=path[k];if(!state.cells[p]){state.cells[p]=selected;added++;}if(width===2){const next=path[k+1]??path[Math.max(0,k-1)];let alt;if(next!==undefined&&Math.abs(next-p)===state.cols){alt=p%state.cols+1<state.cols?p+1:p-1;}else{alt=p+state.cols<state.cells.length?p+state.cols:p-state.cols;}if(alt>=0&&alt<state.cells.length&&!state.cells[alt]){state.cells[alt]=selected;added++;}}}groups=components();}return added;}
 $('connectBtn').onclick=()=>{const n=currentComponents().length;if(n<2)return toast(n?'已连通，不需要补桥。':'请先填色。');const width=Number($('bridgeWidth').value);if(!confirm(`将用当前颜色 ${selected} 添加 ${width} 格宽的连接路径。会改变局部外形，可以撤销。继续？`))return;pushUndo();const added=autoConnect(width);modelChanged();highlight=false;renderAll();toast(`新增 ${added} 颗 ${selected}；目前 ${currentComponents().length} 个连通区域。`);};
 // Local reference handling. Image data never leaves the browser.
 function readFile(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('文件读取失败。'));r.readAsDataURL(file);});}
 function imageFrom(data){return new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('图片无法读取，请使用 PNG / JPG / WebP。'));i.src=data;});}
 async function loadReference(data,name,crop){if(!/^data:image\/(png|jpeg|webp);base64,/i.test(data))throw Error('仅接受本地 PNG / JPG / WebP 图片。');const img=await imageFrom(data);if(img.naturalWidth*img.naturalHeight>32000000)throw Error('图片超过 3200 万像素，请先缩小。');reference={img,data,name,crop:crop||{x:0,y:0,w:img.naturalWidth,h:img.naturalHeight},fit:$('fitMode').value};reference.crop=validCrop(reference.crop,img);$('refThumb').src=data;$('refName').textContent=name;updateRefDims();renderBoard();}
 function validCrop(c,img=reference.img){let x=Math.max(0,Math.min(img.naturalWidth-1,Math.round(Number(c.x)||0))),y=Math.max(0,Math.min(img.naturalHeight-1,Math.round(Number(c.y)||0)));let w=Math.max(1,Math.min(img.naturalWidth-x,Math.round(Number(c.w)||1))),h=Math.max(1,Math.min(img.naturalHeight-y,Math.round(Number(c.h)||1)));return {x,y,w,h};}
 function updateRefDims(){const c=reference.crop;$('refDims').textContent=`裁剪区 ${c.w} × ${c.h} px`;$('fitMode').value=reference.fit;}
 $('uploadRefBtn').onclick=()=>$('refFile').click();
 async function acceptImage(file){if(!/^image\/(png|jpeg|webp)$/i.test(file.type))throw Error('仅支持 PNG / JPG / WebP 图片。');if(file.size>20*1024*1024)throw Error('请选小于 20 MB 的图片。');const data=await readFile(file);await loadReference(data,file.name||'粘贴的图片');openCrop();}
 $('refFile').onchange=guard(async()=>{const f=$('refFile').files[0];if(!f)return;$('refFile').value='';await acceptImage(f);});
 $('dropZone').onclick=()=>$('refFile').click();
 const hasFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
 document.addEventListener('dragover',e=>{if(hasFiles(e)){e.preventDefault();$('dropZone').classList.add('over');}});
 document.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('dropZone').classList.remove('over');});
 document.addEventListener('drop',guard(async e=>{if(!hasFiles(e))return;e.preventDefault();$('dropZone').classList.remove('over');if(document.querySelector('dialog[open]'))return;const f=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(!f)throw Error('请拖入 PNG / JPG / WebP 图片；工程 JSON 请用「打开工程」。');await acceptImage(f);}));
 document.addEventListener('paste',guard(async e=>{if(document.querySelector('dialog[open]')||['INPUT','TEXTAREA'].includes(e.target.tagName))return;const f=[...(e.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));if(!f)return;e.preventDefault();await acceptImage(f);}));
 $('fitMode').onchange=()=>{reference.fit=$('fitMode').value;renderBoard();if(reference.fit==='stretch')toast('拉伸会改变图案比例，建议优先使用等比完整放入。');};
 $('bgTolerance').oninput=()=>$('bgToleranceLabel').textContent=$('bgTolerance').value;
 function syncCropFields(){for(const [id,k]of [['cropX','x'],['cropY','y'],['cropW','w'],['cropH','h']])$(id).value=Math.round(cropTemp[k]);}
 function drawCrop(){const img=reference.img,canvas=$('cropCanvas');const scale=Math.min(1,720/img.naturalWidth,570/img.naturalHeight);canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);ctx.fillStyle='#102C2588';ctx.fillRect(0,0,canvas.width,canvas.height);const c=cropTemp;ctx.drawImage(img,c.x,c.y,c.w,c.h,c.x*scale,c.y*scale,c.w*scale,c.h*scale);ctx.strokeStyle=BLUE;ctx.lineWidth=2;ctx.strokeRect(c.x*scale,c.y*scale,c.w*scale,c.h*scale);}
 function openCrop(){if(!reference.img)return toast('参考图尚未载入。',true);cropTemp=clone(reference.crop);syncCropFields();$('cropDialog').showModal();drawCrop();}
 $('cropBtn').onclick=openCrop;$('cropCancelBtn').onclick=()=>$('cropDialog').close();$('cropFullBtn').onclick=()=>{cropTemp={x:0,y:0,w:reference.img.naturalWidth,h:reference.img.naturalHeight};syncCropFields();drawCrop();};
 for(const id of ['cropX','cropY','cropW','cropH'])$(id).onchange=()=>{cropTemp=validCrop({x:$('cropX').value,y:$('cropY').value,w:$('cropW').value,h:$('cropH').value});syncCropFields();drawCrop();};
 function cropHit(e){const b=$('cropCanvas').getBoundingClientRect();return {x:Math.max(0,Math.min(reference.img.naturalWidth,(e.clientX-b.left)*reference.img.naturalWidth/b.width)),y:Math.max(0,Math.min(reference.img.naturalHeight,(e.clientY-b.top)*reference.img.naturalHeight/b.height))};}
 $('cropCanvas').onpointerdown=e=>{e.preventDefault();cropStart=cropHit(e);$('cropCanvas').setPointerCapture(e.pointerId);};
 $('cropCanvas').onpointermove=e=>{if(!cropStart)return;const p=cropHit(e);cropTemp=validCrop({x:Math.min(p.x,cropStart.x),y:Math.min(p.y,cropStart.y),w:Math.abs(p.x-cropStart.x),h:Math.abs(p.y-cropStart.y)});syncCropFields();drawCrop();};
 $('cropCanvas').onpointerup=()=>cropStart=null;$('cropCanvas').onpointercancel=()=>cropStart=null;
 $('cropRatioBtn').onclick=()=>{
  // Largest centred rectangle with the board's aspect ratio, so the picture fills the grid without distortion.
  const iw=reference.img.naturalWidth,ih=reference.img.naturalHeight,k=Math.min(iw/state.cols,ih/state.rows),w=state.cols*k,h=state.rows*k;cropTemp=validCrop({x:(iw-w)/2,y:(ih-h)/2,w,h});syncCropFields();drawCrop();};
 function applyCrop(){reference.crop=validCrop(cropTemp);updateRefDims();renderBoard();$('cropDialog').close();}
 $('cropApplyBtn').onclick=()=>{applyCrop();toast('裁剪已更新；已填好的豆格不会自动改变。');};
 $('cropConvertBtn').onclick=guard(async()=>{applyCrop();await convertReference();});
 function sampleReference(mode='dominant'){
  if(!reference.img)throw Error('请先导入参考图。');
  // Render the crop into a 12x supersampled target, then reduce every 12x12 block to one colour.
  // dominant: per-channel median of the block centre; ignores thin old gridlines and keeps flat colours crisp.
  // average: mean of the whole block; smoother for photos, softer on hard edges.
  const ss=12,can=document.createElement('canvas');can.width=state.cols*ss;can.height=state.rows*ss;const ctx=can.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';const p=imagePlacement(),c=reference.crop;ctx.drawImage(reference.img,c.x,c.y,c.w,c.h,(p.x-MARGIN)/CELL*ss,(p.y-MARGIN)/CELL*ss,p.w/CELL*ss,p.h/CELL*ss);const pixels=ctx.getImageData(0,0,can.width,can.height).data;const samples=[],average=mode==='average',from=average?0:3,to=average?ss:9,needed=(to-from)**2/3;
  for(let r=0;r<state.rows;r++)for(let c=0;c<state.cols;c++){const channels=[[],[],[]];for(let dy=from;dy<to;dy++)for(let dx=from;dx<to;dx++){const i=((r*ss+dy)*can.width+c*ss+dx)*4;if(pixels[i+3]<128)continue;for(let k=0;k<3;k++)channels[k].push(pixels[i+k]);}if(channels[0].length<needed){samples.push(null);continue;}samples.push(channels.map(a=>{if(average)return Math.round(a.reduce((x,y)=>x+y,0)/a.length);a.sort((x,y)=>x-y);return a[Math.floor(a.length/2)];}));}
  return samples;
 }
 /** Codes typed into 「限定色号」; null when the field is empty (= choose automatically). */
 function fixedCodes(){const raw=$('fixedCodes').value.trim();if(!raw)return null;const codes=[...new Set(raw.split(/[\s,，、;；]+/).filter(Boolean).map(canonical))];if(codes.length<2)throw Error('限定色号至少需要 2 个。');return codes;}
 /** The local conversion: samples in, one bead code (or null) per cell out. Reads every option from the panel. */
 function localConvert(samples){
  const flat=$('sampleMode').value==='dominant',fixed=fixedCodes(),bgMode=$('bgMode').value,dither=$('dither').checked;
  if($('sharpen').checked&&flat)samples=BeadQuantize.sharpenEdges(samples,state.cols,state.rows);
  // H1 is the transparent bead in MARD 221; it stays available by hand but is never auto-matched.
  let beads=fixed?fixed.map(c=>paletteMap.get(c)):palette.filter(c=>c.code!=='H1'),mask=null,maskCode=null;
  if(bgMode!=='keep'){const b=BeadQuantize.backgroundMask(samples,state.cols,state.rows,Number($('bgTolerance').value));mask=b.mask;
   if(bgMode==='unify'&&b.rgb){const wanted=$('bgCode').value.trim();maskCode=wanted?canonical(wanted):BeadQuantize.nearestCode(b.rgb,beads);if(!beads.some(c=>c.code===maskCode))beads=[...beads,paletteMap.get(maskCode)];}}
  return BeadQuantize.quantize(samples,state.cols,state.rows,beads,{limit:fixed?0:Number($('colorLimit').value),dither,cleanup:dither?'none':$('cleanupLevel').value,mask,maskCode,maskExclusive:$('bgReserve').checked});
 }
 // Optional AI adviser. It receives a small thumbnail and the first-pass colour list, and only fills in the
 // options above; the conversion itself stays local. Nothing is sent unless the box is ticked.
 const aiStorageKey='bead-grid-studio-ai';
 function aiConfig(){return {apiKey:$('aiKey').value.trim(),baseUrl:$('aiBase').value.trim()||BeadAI.DEFAULTS.baseUrl,model:$('aiModel').value.trim()||BeadAI.DEFAULTS.model,effort:$('aiEffort').value};}
 function syncAI(){const on=$('aiEnabled').checked;$('aiFields').hidden=!on;$('privacyText').textContent=on?'AI 已开启 · 生成时上传缩略图':'离线运行 · 图片不上传';}
 function saveAI(){try{if($('aiRemember').checked)localStorage.setItem(aiStorageKey,JSON.stringify({...aiConfig(),enabled:$('aiEnabled').checked}));else localStorage.removeItem(aiStorageKey);}catch{/* storage unavailable: settings last for this page only */}syncAI();}
 for(const id of ['aiEnabled','aiKey','aiBase','aiModel','aiEffort','aiRemember'])$(id).onchange=saveAI;
 $('aiForgetBtn').onclick=()=>{$('aiKey').value='';try{localStorage.removeItem(aiStorageKey);}catch{}saveAI();toast('已清除本浏览器保存的 API Key。');};
 function referenceThumb(max=512){const c=reference.crop,k=Math.min(1,max/Math.max(c.w,c.h)),can=document.createElement('canvas');can.width=Math.max(1,Math.round(c.w*k));can.height=Math.max(1,Math.round(c.h*k));const ctx=can.getContext('2d');ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,can.width,can.height);ctx.drawImage(reference.img,c.x,c.y,c.w,c.h,0,0,can.width,can.height);return can.toDataURL('image/jpeg',.85);}
 async function askAI(samples){
  if($('sharpen').checked)samples=BeadQuantize.sharpenEdges(samples,state.cols,state.rows);
  const first=BeadQuantize.quantize(samples,state.cols,state.rows,palette.filter(c=>c.code!=='H1'),{cleanup:'none'}),count=new Map();
  for(const code of first)if(code)count.set(code,(count.get(code)||0)+1);
  const candidates=[...count].sort((a,b)=>b[1]-a[1]).map(([code,cells])=>({code,hex:paletteMap.get(code).hex,cells})),lab=code=>rgbToLab(hexRgb(paletteMap.get(code).hex));
  return BeadAI.advise(aiConfig(),{imageDataUrl:referenceThumb(),candidates,maxColors:Number($('colorLimit').value),cols:state.cols,rows:state.rows,distance:(a,b)=>BeadQuantize.deltaE00(lab(a),lab(b))});
 }
 function applyAdvice(a){$('sampleMode').value=a.sampling;$('bgMode').value=a.background;$('bgCode').value=a.backgroundCode||'';$('bgReserve').checked=a.reserveBackground;$('cleanupLevel').value=a.cleanup;$('fixedCodes').value=a.palette.join(', ');$('aiNote').textContent=[`AI 判断：${a.subject||'（未描述）'}。选定 ${a.palette.length} 个色号，已填入上方选项，可手动修改后重新生成。`,...a.warnings.map(w=>'· '+w)].join('\n');}
 async function convertReference(){if(!reference.img)throw Error('请先载入参考图。');fixedCodes();if($('aiEnabled').checked&&!$('aiKey').value.trim())throw Error('已勾选 AI 辅助，请先填写 API Key，或取消勾选。');if(state.cells.some(Boolean)&&!confirm('用参考图重新生成图纸？当前格子会被替换，可撤销。'))return;$('convertBtn').disabled=true;$('convertBtn').textContent='正在取色与匹配…';await new Promise(r=>setTimeout(r,25));
  try{let samples=sampleReference($('sampleMode').value),aiError='';
   if($('aiEnabled').checked){$('convertBtn').textContent=$('aiEffort').value==='fast'?'AI 正在分析…':'AI 正在仔细分析（约半分钟）…';
    try{const advice=await askAI(samples),resample=advice.sampling!==$('sampleMode').value;applyAdvice(advice);if(resample)samples=sampleReference(advice.sampling);}
    catch(e){console.error(e);aiError=e.message||String(e);$('aiNote').textContent='AI 未生效：'+aiError;}
    $('convertBtn').textContent='正在取色与匹配…';await new Promise(r=>setTimeout(r,25));}
   const mapped=localConvert(samples);
   pushUndo();state.cells=mapped;modelChanged();$('showReference').checked=false;highlight=false;renderAll();renderPalette();const a=audit(),summary=`${a.usedBeads} 颗 / ${a.colorCount} 色，${a.connectedComponents} 个连通区域`;
   if(aiError)toast(`AI 未生效（${aiError}）已按当前本地选项生成：${summary}。`,true);else toast(`图纸已生成：${summary}。请检查细节后导出。`);
  }finally{$('convertBtn').disabled=false;$('convertBtn').textContent='生成拼豆图纸';}
 }
 $('convertBtn').onclick=guard(convertReference);
 // Validate imports completely before replacing live data.
 function validateState(input){if(!input||typeof input!=='object')throw Error('工程格式无效。');const cols=Number(input.cols),rows=Number(input.rows),mm=Number(input.mm);if(!validSide(cols)||!validSide(rows))throw Error(`工程行列必须是 ${MIN_SIDE}–${MAX_SIDE} 内的整数。`);if(!BEAD_MM.includes(mm))throw Error('工程豆子规格无效。');const boardW=Number(input.boardW)||0,boardH=Number(input.boardH)||0;if(!Number.isInteger(boardW)||!Number.isInteger(boardH)||boardW<0||boardH<0||boardW>MAX_SIDE||boardH>MAX_SIDE||!boardW!==!boardH)throw Error('工程底板规格无效。');if(!Array.isArray(input.cells)||input.cells.length!==cols*rows)throw Error('工程格子数与行列不一致。');const cells=input.cells.map(c=>c===null||c===''?null:canonical(c));return {cols,rows,mm,boardW,boardH,title:String(input.title||'未命名图纸').slice(0,60),majorStyle:input.majorStyle==='solid'?'solid':'dashed',cells,paletteStatus:String(input.paletteStatus||'community').slice(0,50),revision:Number(input.revision)||0};}
 function validatePalette(input){const a=Array.isArray(input)?input:input.colors;if(!Array.isArray(a)||a.length!==221)throw Error('色库需包含完整的 221 个色号。');const seen=new Set(),colors=a.map(c=>{const code=canonical(c.code);if(seen.has(code))throw Error('色库有重复色号：'+code);seen.add(code);if(!/^#[0-9a-f]{6}$/i.test(c.hex))throw Error(code+' 的 HEX 色值无效。');return {code,hex:c.hex.toUpperCase()};});if(seen.size!==221)throw Error('色号不完整。');return BASE_PALETTE.map(b=>colors.find(c=>c.code===b.code));}
 function projectData(){return {format:'bead-grid-studio',version:1,savedAt:new Date().toISOString(),state:clone(state),palette:{id:'mard-221',status:state.paletteStatus,attribution:'Color data: craft-color-codes by MakeBead',license:'CC-BY-4.0',source:'https://github.com/makebead/craft-color-codes/blob/main/data/json/mard-221.json',colors:clone(palette)},reference:reference.img?{data:reference.data,name:reference.name,crop:clone(reference.crop),fit:reference.fit}:null};}
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 function jsonDownload(data,name){download(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),name);}
 $('saveProjectBtn').onclick=()=>{jsonDownload(projectData(),'bead-project.json');toast('已导出工程 JSON，包含格子、色库和参考图。');};
 $('loadProjectBtn').onclick=()=>$('projectFile').click();
 $('projectFile').onchange=guard(async()=>{const f=$('projectFile').files[0];if(!f)return;if(f.size>35*1024*1024)throw Error('工程超过 35 MB。');const obj=JSON.parse(await f.text());if(obj.format!=='bead-grid-studio'||obj.version!==1)throw Error('不支持的工程格式或版本。');const newState=validateState(obj.state),newPalette=validatePalette(obj.palette);let newRef=null;if(obj.reference){if(typeof obj.reference.data!=='string'||!/^data:image\/(png|jpeg|webp);base64,/i.test(obj.reference.data))throw Error('参考图字段无效。');const img=await imageFrom(obj.reference.data);if(img.naturalWidth*img.naturalHeight>32000000)throw Error('参考图过大。');newRef={img,data:obj.reference.data,name:String(obj.reference.name||'工程参考图').slice(0,100),crop:validCrop(obj.reference.crop||{x:0,y:0,w:img.naturalWidth,h:img.naturalHeight},img),fit:['contain','cover','stretch'].includes(obj.reference.fit)?obj.reference.fit:'contain'};}if(state.cells.some(Boolean)&&!confirm('打开工程将替换当前内容。继续吗？'))return;state=newState;setPalette(newPalette);componentsCache=null;undoStack=[];redoStack=[];if(newRef){reference=newRef;$('refThumb').src=reference.data;$('refName').textContent=reference.name;updateRefDims();}syncSettings();renderPalette();renderAll();fitView();scheduleCache();$('projectFile').value='';toast('工程已载入。');});
 $('exportPaletteBtn').onclick=()=>jsonDownload({id:'mard-221',status:state.paletteStatus,attribution:'Color data: craft-color-codes by MakeBead',license:'CC-BY-4.0',colors:palette},'mard221-colors.json');
 $('importPaletteBtn').onclick=()=>$('paletteFile').click();
 $('paletteFile').onchange=guard(async()=>{const f=$('paletteFile').files[0];if(!f)return;if(f.size>1024*1024)throw Error('色库文件过大。');const p=validatePalette(JSON.parse(await f.text()));pushUndo();setPalette(p);state.paletteStatus='user-imported';modelChanged();renderPalette();renderAll();$('paletteFile').value='';toast('221 色库已替换，矩阵中的色号不变。');});
 // Exports: regenerate from the matrix; never rasterize the editor/reference layer.
 function checkExport(){const a=audit();if(!a.gridValid||!a.validCodes)throw Error('网格自检未通过，已阻止导出。');if($('strictExport').checked&&a.usedBeads&&a.connectedComponents!==1){highlight=true;renderBoard();throw Error(`仍有 ${a.connectedComponents} 个分离部分。请补连接，或取消连通限制以导出检查稿。`);}return a;}
 function exportedSVG(view=null){const a=checkExport(),s=gridSVG({labels:true,grid:true,ref:false,mark:false,legend:true,view});const mmPerUnit=state.mm/CELL,v=view||state;return {w:s.w,h:s.h,svg:`<svg xmlns="${NS}" width="${s.w*mmPerUnit}mm" height="${s.h*mmPerUnit}mm" viewBox="0 0 ${s.w} ${s.h}" role="img"><title>${escape(state.title)} — ${v.cols}×${v.rows} 精确拼豆图纸</title><desc>${escape(JSON.stringify(a))}</desc>${s.content}</svg>`};}
 const fileBase=()=>(state.title.replace(/[\\/:*?"<>|\s]+/g,'-').replace(/^-+|-+$/g,'')||'bead-pattern');
 // 2x for sharp codes, unless that would exceed what browsers reliably allocate for a canvas.
 const pngScale=a=>Math.max(a.w,a.h)*2<=8192?2:1;
 async function rasterize(svg,w,h){const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));try{const img=await imageFrom(url),canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0,w,h);const blob=await new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(Error('PNG 导出失败。')),'image/png'));return blob;}finally{URL.revokeObjectURL(url);}}
 async function exportPNG(){const a=exportedSVG(),scale=pngScale(a);const blob=await rasterize(a.svg,a.w*scale,a.h*scale);download(blob,`${fileBase()}-${state.cols}x${state.rows}.png`);toast('高清图已导出：来自矩阵，不含参考图片。');return blob;}
 function boardViews(){const b=boards(),views=[];for(let by=0;by<b.ny;by++)for(let bx=0;bx<b.nx;bx++)views.push({bx,by,c0:bx*b.bw,r0:by*b.bh,cols:Math.min(b.bw,state.cols-bx*b.bw),rows:Math.min(b.bh,state.rows-by*b.bh)});return views;}
 async function exportBoards(){const views=boardViews();if(views.length<2)throw Error('当前图纸只占一块底板，直接导出高清 PNG 即可。');for(const view of views){const a=exportedSVG(view),scale=pngScale(a);download(await rasterize(a.svg,a.w*scale,a.h*scale),`${fileBase()}-board-${view.by+1}-${view.bx+1}.png`);await new Promise(r=>setTimeout(r,400));}toast(`已按底板导出 ${views.length} 张图；行列编号沿用整图坐标。`);}
 async function purePNG(){checkExport();const size=40,can=document.createElement('canvas');can.width=state.cols*size;can.height=state.rows*size;const ctx=can.getContext('2d');ctx.imageSmoothingEnabled=false;state.cells.forEach((code,i)=>{if(code){ctx.fillStyle=paletteMap.get(code).hex;ctx.fillRect(i%state.cols*size,Math.floor(i/state.cols)*size,size,size);}});const b=await new Promise((resolve,reject)=>can.toBlob(b=>b?resolve(b):reject(Error('PNG 导出失败。')),'image/png'));download(b,'bead-pixels.png');}
 $('exportPngBtn').onclick=guard(exportPNG);$('topExportBtn').onclick=()=>{$('exportSection').scrollIntoView({behavior:'smooth',block:'center'});};
 $('exportSvgBtn').onclick=guard(()=>{const a=exportedSVG();download(new Blob([a.svg],{type:'image/svg+xml;charset=utf-8'}),`${fileBase()}-actual-size.svg`);toast('SVG 已写入实际毫米尺寸；打印前请核对标尺。');});
 $('exportPureBtn').onclick=guard(purePNG);$('exportBoardsBtn').onclick=guard(exportBoards);
 const csvEscape=value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
 function matrixCSV(){const lines=[['row / col',...Array.from({length:state.cols},(_,i)=>i+1)]];for(let r=0;r<state.rows;r++)lines.push([r+1,...state.cells.slice(r*state.cols,(r+1)*state.cols).map(c=>c||'')]);return '\ufeff'+lines.map(row=>row.map(csvEscape).join(',')).join('\r\n');}
 function usageCSV(){const data=[['code','hex','beads'],...usage().map(([c,n])=>[c,paletteMap.get(c).hex,n]),['TOTAL','',usage().reduce((sum,[c,n])=>sum+n,0)]];return '\ufeff'+data.map(row=>row.map(csvEscape).join(',')).join('\r\n');}
 $('exportCsvBtn').onclick=()=>download(new Blob([matrixCSV()],{type:'text/csv;charset=utf-8'}),'bead-matrix.csv');$('exportUsageBtn').onclick=()=>download(new Blob([usageCSV()],{type:'text/csv;charset=utf-8'}),'bead-usage.csv');
 function showReport(){const a=audit();$('reportText').textContent=[`${a.gridValid&&a.validCodes?'PASS':'FAIL'}  网格与色号检查`,`矩阵：${a.rows} 行 × ${a.cols} 列 = ${a.totalCells} 格`,`纵向边界 ${a.verticalBoundaryLines} 条 / 横向边界 ${a.horizontalBoundaryLines} 条`,`相邻蓝线之间的列数：${a.columnsPerBlueInterval.join(' / ')}`,`相邻蓝线之间的行数：${a.rowsPerBlueInterval.join(' / ')}`,`每组内部细分线：${a.minorLinesInsideBlueInterval} 条 → 5 个格子（末组不足 5 格时按实际格数）`,`豆径 ${a.nominalBeadMm} mm；成品约 ${mmText(a.cols)} × ${mmText(a.rows)} mm`,a.boardPegs?`底板 ${a.boardPegs.join('×')}：横 ${a.boardsNeeded[0]} × 纵 ${a.boardsNeeded[1]} = ${a.boardsNeeded[0]*a.boardsNeeded[1]} 块`:'底板：自定义格数，未设拼板',`已放 ${a.usedBeads} 颗 / 留空 ${a.emptyCells} 格 / 用色 ${a.colorCount}`,`连通块：${a.connectedComponents} 个 ${a.connectivityPassed?'（四邻接通过）':a.usedBeads?'（尚未全部连接）':'（空白模板）'}`,`参考图是否进入正式导出：否`,`色库：${a.paletteStatus}（屏幕参考，非实物校准）`].join('\n');$('reportDialog').showModal();}
 $('validateBtn').onclick=showReport;$('downloadReportBtn').onclick=()=>jsonDownload(audit(),'bead-validation.json');$('reportCloseBtn').onclick=()=>$('reportDialog').close();$('helpBtn').onclick=()=>$('helpDialog').showModal();$('helpCloseBtn').onclick=()=>$('helpDialog').close();
 document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)||document.querySelector('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();}else{const tools={b:'draw',e:'erase',f:'fill',i:'pick',v:'pan'};if(tools[e.key.toLowerCase()]){e.preventDefault();setTool(tools[e.key.toLowerCase()]);}}});
 // Public read-only snapshots and explicitly mutating hooks for tests / further integration.
 window.BeadStudio={localConvert,aiConfig,audit,geometry,boards,boardViews,gridSVG,sampleReference,exportBoards,components:(cells,cols,rows)=>components(cells,cols,rows),getState:()=>clone(state),getPalette:()=>clone(palette),exportedSVG,matrixCSV,usageCSV,projectData,convertReference,renderAll,undo,redo,validateState,validatePalette,normalize,
  setCells(cells){if(cells.length!==state.cols*state.rows)throw Error('Incorrect cell count');const next=cells.map(c=>c===null?null:canonical(c));pushUndo();state.cells=next;modelChanged();renderAll();},
  connect(width=2){pushUndo();const count=autoConnect(width);modelChanged();renderAll();return count;},
  setSelected:selectColor,ready:false};
 setPalette(BASE_PALETTE);
 try{const cached=JSON.parse(localStorage.getItem(storageKey)||'null');if(cached){const s=validateState(cached.state),p=validatePalette(cached.palette);state=s;setPalette(p);$('saveStatus').textContent='已恢复本地格子 · 参考图为校验示例';}}catch{/* Keep a clean state when storage is unavailable or corrupt. */}
 try{const saved=JSON.parse(localStorage.getItem(aiStorageKey)||'null');if(saved&&typeof saved==='object'){$('aiKey').value=String(saved.apiKey||'');$('aiBase').value=String(saved.baseUrl||'');$('aiModel').value=String(saved.model||'');if(saved.effort==='fast')$('aiEffort').value='fast';$('aiEnabled').checked=saved.enabled===true;}}catch{/* ignore unreadable settings */}
 if(!$('aiBase').value)$('aiBase').value=BeadAI.DEFAULTS.baseUrl;if(!$('aiModel').value)$('aiModel').value=BeadAI.DEFAULTS.model;syncAI();
 syncSettings();renderPalette();renderAll();
 loadReference(BUILTIN_REFERENCE,'内置示例 · 爱拼才会赢 50×50',BUILTIN_CROP).then(()=>{window.BeadStudio.ready=true;fitView();}).catch(e=>{toast(e.message,true);window.BeadStudio.ready=true;fitView();});
 let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!drawing)fitView();},180);});
})();
