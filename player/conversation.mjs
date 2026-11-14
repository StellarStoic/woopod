import { RELAYS, verified, draft, sameUnsigned, values, thread, readDiscussion, relayPublish } from './social.mjs';

export function mountConversation({ request, metadata, shareUrl, onClipRoot }) {
  const dialog=document.querySelector('#conversation'), list=document.querySelector('#comments'), status=document.querySelector('#social-status');
  const compose=document.querySelector('#comment-text'), send=document.querySelector('#comment-send'), retry=document.querySelector('#comment-retry'), older=document.querySelector('#comments-older');
  const scopeSelect=document.querySelector('#comment-scope');
  const feedId=metadata.podcastGuid?`podcast:guid:${metadata.podcastGuid}`:'';
  const episodeId=metadata.episodeGuidSource==='eg'&&metadata.episodeGuid?`podcast:item:guid:${metadata.episodeGuid}`:metadata.audio;
  const episodeScope={id:episodeId,kind:episodeId.startsWith('podcast:item:guid:')?'podcast:item:guid':'web',title:metadata.title,link:metadata.audio,feedId};
  const scopes={episode:episodeScope};
  if(feedId||request.feed)scopes.podcast={id:feedId||request.feed,kind:feedId?'podcast:guid':'web',title:metadata.podcast,link:request.feed||metadata.feed,feedId};
  if(request.mode==='clip'&&!request.demo)scopes.clip={...episodeScope,link:shareUrl(),clipRoot:request.clipRoot||null};
  scopeSelect.replaceChildren();
  for(const name of Object.keys(scopes)){const option=document.createElement('option');option.value=name;option.textContent=name==='podcast'?'Podcast':name==='clip'?'This clip':'Episode';scopeSelect.append(option);}
  scopeSelect.value=scopes.clip?'clip':'episode';
  let scope=scopes[scopeSelect.value], events=[], cursors={}, controller=null, parent=null, key=null, pending=null, busy=false;
  let muted=[];try{muted=JSON.parse(localStorage.getItem('woopod-social-muted')||'[]');}catch{}
  const label=pubkey=>`${pubkey.slice(0,10)}…${pubkey.slice(-5)}`;
  const note=(text)=>{status.textContent=text;};
  const unmute=document.querySelector('#comments-unmute');
  unmute.addEventListener('click',()=>{muted=[];try{localStorage.removeItem('woopod-social-muted');}catch{}render();});
  const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',action);return b;};
  const scopeKey=()=>scope.clipRoot||scope.link;
  function remember(){if(pending)try{localStorage.setItem(`woopod-social-outbox:${scopeKey()}`,JSON.stringify(pending));}catch{throw Error('The browser could not save this post for a safe retry. Nothing was sent.');}}
  function restore(){pending=null;try{const saved=JSON.parse(localStorage.getItem(`woopod-social-outbox:${scopeKey()}`));if(saved&&verified(saved.event))pending=saved;}catch{}retry.hidden=!pending;}
  function render(){
    unmute.hidden=!muted.length;list.replaceChildren();const rows=thread(scope,events,muted);
    if(!rows.length){const empty=document.createElement('p');empty.textContent='No public comments loaded yet.';list.append(empty);}
    for(const event of rows){const item=document.createElement('article');item.className='public-comment';
      const author=document.createElement('strong');author.textContent=label(event.pubkey);
      const time=document.createElement('time');time.dateTime=new Date(event.created_at*1000).toISOString();time.textContent=new Date(event.created_at*1000).toLocaleString();
      const body=document.createElement('p');body.textContent=event.content;
      item.append(author,time,body);
      if(event.kind===1)item.append(button('Reply',()=>{parent=event;document.querySelector('#reply-target').textContent=`Replying to ${label(event.pubkey)}`;compose.focus();}));
      item.append(button('Mute author',()=>{muted=[...new Set([...muted,event.pubkey])];try{localStorage.setItem('woopod-social-muted',JSON.stringify(muted));}catch{}render();}));
      list.append(item);
    }
    scopeSelect.disabled=busy;compose.disabled=busy;
    send.disabled=busy||request.demo;send.textContent=busy?'Waiting for confirmation…':scopeSelect.value==='clip'&&!scope.clipRoot?'Post clip publicly':'Post publicly';
  }
  async function load(append=false){
    controller?.abort();
    if(scopeSelect.value==='clip'&&!scope.clipRoot){events=[];render();note('Post this clip publicly to start its own conversation.');return;}
    controller=new AbortController();const active=scope;note('Loading public comments…');
    try{const result=await readDiscussion(active,{previous:append?events:[],cursors:append?cursors:{},signal:controller.signal});if(active!==scope)return;events=result.events;cursors=result.cursors;older.hidden=!result.more;render();note(result.warnings.length?[...new Set(result.warnings)].join(' '):'Public conversation · Fountain and compatible apps.');}
    catch(e){if(e.name!=='AbortError')note('Comments could not load. Refresh to try again.');}
  }
  async function publish(){
    if(!pending)return;busy=true;render();
    try{
      remember();const accepted=new Set(pending.accepted||[]);
      const destinations=pending.event.tags.some(t=>t[0]==='woopod')?RELAYS:RELAYS.slice(0,2);
      const result=await Promise.allSettled(destinations.filter(r=>!accepted.has(r)).map(r=>relayPublish(r,pending.event)));
      result.forEach(r=>{if(r.status==='fulfilled')accepted.add(r.value);});pending.accepted=[...accepted];remember();
      if(accepted.size){compose.value='';parent=null;document.querySelector('#reply-target').textContent='';events=[...new Map([...events,pending.event].map(e=>[e.id,e])).values()];
        if(scopeSelect.value==='clip'&&!scope.clipRoot){const oldKey=scopeKey();scope.clipRoot=pending.event.id;onClipRoot?.(scope.clipRoot);remember();try{localStorage.removeItem(`woopod-social-outbox:${oldKey}`);}catch{}}
      }
      note(accepted.size?`Accepted by ${[...accepted].map(r=>new URL(r).hostname).join(', ')}. ${accepted.has(RELAYS[0])?"Fountain’s indexing may take time.":'Fountain is still unconfirmed. Retry uses the same post.'}${!destinations.includes(RELAYS[2])?' Woopod storage is not configured on this website.':''}`:'No relay confirmed publication. Retry sends the same signed post.');
      retry.hidden=false;
    }catch(e){note(e.message);}finally{busy=false;render();}
  }
  document.querySelector('#open-conversation').addEventListener('click',()=>{dialog.showModal();restore();render();if(request.demo)note('Sound preview. Open a real episode share link to read or post comments.');else load();});
  document.querySelector('#close-conversation').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>controller?.abort());
  scopeSelect.addEventListener('change',()=>{if(busy)return;scope=scopes[scopeSelect.value];parent=null;events=[];cursors={};document.querySelector('#reply-target').textContent='';restore();render();if(!request.demo)load();});
  document.querySelector('#comments-refresh').addEventListener('click',()=>{if(!request.demo)load();});
  older.addEventListener('click',()=>load(true));
  document.querySelector('#cancel-reply').addEventListener('click',()=>{parent=null;document.querySelector('#reply-target').textContent='';});
  retry.addEventListener('click',async()=>{try{if(!window.nostr)throw Error('Connect a Nostr browser signer to retry your post.');key=await window.nostr.getPublicKey();if(key!==pending?.event.pubkey)throw Error('Reconnect the account that signed this post.');await publish();}catch(e){note(e.message);}});
  document.querySelector('#comment-form').addEventListener('submit',async e=>{
    e.preventDefault();if(busy||request.demo)return;
    busy=true;render();
    try{
      if(!window.nostr?.signEvent)throw Error('Connect a Nostr browser signer to post. Your private key stays with your signer.');
      key=await window.nostr.getPublicKey();
      const reply=parent||(scope.clipRoot?thread(scope,events).find(e=>e.id===scope.clipRoot):null);
      const unsigned=draft(scope,key,compose.value,reply);
      // This optional same-origin service returns an admission tag, never a private key.
      try{const response=await fetch(new URL('../api/v1/admission',location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pubkey:key,created_at:unsigned.created_at,kind:unsigned.kind,tags:unsigned.tags,content:unsigned.content}),signal:AbortSignal.timeout(6000)});if(response.ok){const result=await response.json();if(Array.isArray(result.tag)&&result.tag[0]==='woopod'&&/^[0-9a-f]{128}$/.test(result.tag[1]))unsigned.tags.push(result.tag);}}catch{}
      const signed=await window.nostr.signEvent(unsigned);
      if(!sameUnsigned(unsigned,signed)||!verified(signed))throw Error('The signer changed the message or returned an invalid signature. Nothing was sent.');
      pending={event:signed,accepted:[]};remember();await publish();
    }catch(e){note(e.message);}finally{busy=false;render();}
  });
  window.addEventListener('pagehide',()=>controller?.abort());
}
