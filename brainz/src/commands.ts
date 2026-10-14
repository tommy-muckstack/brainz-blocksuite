export interface CanvasCommand {
  id: string;
  label: string;
  group: 'Tools' | 'Insert' | 'Arrange' | 'View' | 'Board' | 'Brainz' | 'AI';
  keys?: string;
  when?: () => boolean;
  run: () => void;
}

export function commandScore(query: string, value: string): number {
  const needle = query.trim().toLowerCase(), haystack = value.toLowerCase();
  if (!needle) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 1000-exact-haystack.length/100;
  let cursor=0, score=0, previous=-2;
  for (const character of needle) {
    const index=haystack.indexOf(character,cursor);
    if (index<0) return -Infinity;
    score += index===previous+1 ? 10 : 1;
    if (index===0 || haystack[index-1]===' ') score+=8;
    cursor=index+1; previous=index;
  }
  return score-haystack.length/100;
}

export class CanvasCommands {
  private panel = document.createElement('section');
  private input = document.createElement('input');
  private results = document.createElement('div');
  private active = 0;
  private matches: CanvasCommand[] = [];
  private recent: string[] = [];
  private previousFocus?: HTMLElement;
  private mode:'commands'|'shortcuts'|'context'='commands';

  constructor(private commands: () => CanvasCommand[]) {
    this.panel.className='canvas-command-panel'; this.panel.hidden=true; this.panel.setAttribute('role','dialog'); this.panel.setAttribute('aria-label','Canvas commands');
    this.input.placeholder='Find a canvas command…'; this.input.setAttribute('aria-label','Find a canvas command'); this.input.setAttribute('role','combobox'); this.input.setAttribute('aria-autocomplete','list'); this.input.setAttribute('aria-controls','canvas-command-results');
    this.results.id='canvas-command-results'; this.results.setAttribute('role','listbox');
    const footer=document.createElement('footer'); footer.textContent='↑↓ navigate · Enter run · Esc close';
    this.panel.append(this.input,this.results,footer); document.body.append(this.panel);
    try { const value=JSON.parse(localStorage.getItem('brainz-canvas-recent-commands') ?? '[]'); if(Array.isArray(value)) this.recent=value.filter(id=>typeof id==='string').slice(0,10); } catch { this.recent=[]; }
    this.input.oninput=()=>{this.active=0;this.render();};
    this.panel.addEventListener('keydown',event=>{
      if (event.key==='Escape') {event.preventDefault();this.close();}
      else if (event.key==='ArrowDown' || event.key==='ArrowUp') {event.preventDefault();this.active=(this.active+(event.key==='ArrowDown'?1:-1)+this.matches.length)%Math.max(1,this.matches.length);this.render();}
      else if (event.key==='Enter') {event.preventDefault();this.run(this.matches[this.active]);}
      event.stopPropagation();
    });
    document.addEventListener('pointerdown',event=>{if(this.open && !this.panel.contains(event.target as Node) && !(event.target as HTMLElement).closest('#commands'))this.close();},true);
  }

  get open() { return !this.panel.hidden; }

  show(mode:'commands'|'shortcuts'|'context'='commands', point?:{x:number;y:number}) {
    this.mode=mode;
    this.panel.setAttribute('aria-label',mode==='shortcuts'?'Canvas shortcuts':'Canvas commands');
    this.input.placeholder=mode==='shortcuts'?'Find a shortcut…':'Find a canvas command…';
    this.panel.dataset.mode=mode;
    this.panel.style.left=point?`${Math.max(8,Math.min(innerWidth-348,point.x))}px`:'';
    this.panel.style.top=point?`${Math.max(64,Math.min(innerHeight-300,point.y))}px`:'';
    this.panel.style.transform=point?'none':'';
    this.previousFocus=document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.panel.hidden=false; this.input.value=''; this.active=0; this.input.setAttribute('aria-expanded','true'); this.render(); this.input.focus();
  }

  close() {this.panel.hidden=true;this.input.setAttribute('aria-expanded','false');this.previousFocus?.focus();}

  private run(command?: CanvasCommand) {
    if (!command) return;
    this.close(); this.recent=[command.id,...this.recent.filter(id=>id!==command.id)].slice(0,10);
    try {localStorage.setItem('brainz-canvas-recent-commands',JSON.stringify(this.recent));} catch { /* Commands still work when local preferences cannot be written. */ }
    command.run();
  }

  private render() {
    const query=this.input.value;
    this.matches=this.commands().filter(command=>(!command.when || command.when()) && (this.mode!=='shortcuts' || command.keys)).map(command=>({command,score:commandScore(query,`${command.label} ${command.group}`)+(query ? 0 : Math.max(0,10-this.recent.indexOf(command.id))*(this.recent.includes(command.id)?100:0))})).filter(item=>Number.isFinite(item.score)).sort((a,b)=>b.score-a.score || a.command.group.localeCompare(b.command.group)).slice(0,40).map(item=>item.command);
    this.active=Math.min(this.active,Math.max(0,this.matches.length-1)); this.results.replaceChildren();
    if (!this.matches.length) {const empty=document.createElement('p');empty.textContent='No matching commands';this.results.append(empty);}
    this.matches.forEach((command,index)=>{
      const button=document.createElement('button');button.id=`canvas-command-${index}`;button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===this.active));
      const label=document.createElement('span');label.textContent=command.label;
      const group=document.createElement('small');group.textContent=command.group;
      const keys=document.createElement('kbd');keys.textContent=command.keys ?? '';
      button.append(label,group,keys);button.onclick=()=>this.run(command);this.results.append(button);
    });
    this.input.setAttribute('aria-activedescendant',`canvas-command-${this.active}`);
    this.results.children[this.active]?.scrollIntoView({block:'nearest'});
  }
}
