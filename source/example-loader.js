/* Load the verified example directly as data, never sample its preview. */
(() => {
  const button = document.createElement('button');
  button.textContent = '载入校验示例';
  button.title = '50×50、5mm、每5格蓝线、2500颗、12色；H12背景也铺豆';
  button.className = 'small';
  document.getElementById('loadProjectBtn').insertAdjacentElement('afterend', button);
  button.onclick = () => {
    if (!window.BeadStudio || !window.BeadStudio.ready) return;
    const project = {
      format: 'bead-grid-studio', version: 1,
      state: {cols:50, rows:50, mm:5, title:'爱拼才会赢 · 50×50 校验版',
        majorStyle:'solid', cells:[...VERIFIED_CELLS], paletteStatus:'community', revision:1},
      palette: {id:'mard-221', status:'community', attribution:'Color data: craft-color-codes by MakeBead',
        license:'CC-BY-4.0', colors:BASE_PALETTE.map(c=>({...c}))},
      reference:null
    };
    const file = new File([JSON.stringify(project)], 'aipin_verified_project.json', {type:'application/json'});
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('projectFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  };
})();
